import deepEqual from 'fast-deep-equal';
import {Window} from 'hadouken-js-adapter';
import {WindowInfo} from 'hadouken-js-adapter/out/types/src/api/window/window';
import {Aggregators, Signal} from 'openfin-service-signal';

import {WindowScope} from '../../../gen/provider/config/layouts-config';
import {LayoutsEvent} from '../../client/connection';
import {SERVICE_IDENTITY} from '../../client/internal';
import {WindowState} from '../../client/workspaces';
import {EVENT_CHANNEL_TOPIC} from '../APIMessages';
import {apiHandler} from '../main';
import {Debounced} from '../snapanddock/utils/Debounced';
import {isWin10} from '../snapanddock/utils/platform';
import {Point} from '../snapanddock/utils/PointUtils';
import {Rectangle} from '../snapanddock/utils/RectUtils';
import {forEachProperty} from '../utils/iteration';

import {WindowIdentity} from './Identity';
import {DesktopEntity} from './DesktopEntity';
import {DesktopModel} from './DesktopModel';
import {DesktopSnapGroup} from './DesktopSnapGroup';
import {DesktopTabGroup} from './DesktopTabGroup';

export interface EntityState extends Rectangle {
    center: Point;
    halfSize: Point;

    frame: boolean;
    hidden: boolean;
    state: WindowState;

    icon: string;
    title: string;
    showTaskbarIcon: boolean;

    resizeConstraints: Point<ResizeConstraint>;

    opacity: number;

    alwaysOnTop: boolean;
    maximizable: boolean;
}

export interface ResizeConstraint {
    // Window is resizable by the edge closest to the origin (left/top)
    resizableMin: boolean;
    // Window is resizable by the edge furthest from the origin (right/bottom)
    resizableMax: boolean;
    minSize: number;
    maxSize: number;
}

/**
 * Use of this type indicates that the field is a bit mask. Variables using this type will be either a value from the
 * enum 'T', or a bitwise-or of multiple enum values. There's no way to easily enforce this in TypeScript currently, so
 * this type definition is in many ways just a convention that indicates intended usage of the variable.
 *
 * This type should only ever be used with enums, where each enum value is a power of two.
 */
export type Mask<T> = T|number;

export enum eTransformType {
    MOVE = 1 << 0,
    RESIZE = 1 << 1
}

interface BoundsChange {
    transformType: Mask<eTransformType>;
    startBounds: Rectangle;
}

enum ActionOrigin {
    /**
     * A change made by the application itself.
     *
     * Service should still allow applications to use the OpenFin API's directly. In cases where the service needs to
     * override the application's behaviour, it should always make an effort to restore the application's state
     * afterward.
     */
    APPLICATION,

    /**
     * A change made by the service that is intended to be permanent or long-lived. These are changes that will either
     * never be reverted, or only reverted once the service is done with the window.
     *
     * e.g: Resizing a window when it is dropped into a tab set.
     */
    SERVICE,

    /**
     * A change made by the service that is intended to be very short-lived, and will soon be reverted.
     *
     * These changes can be reverted using 'DesktopWindow.resetOverride'
     *
     * e.g: Applying opacity effects when dragging windows and snap/tab previews.
     */
    SERVICE_TEMPORARY
}

enum LifecycleStage {
    STARTING,
    READY,
    ENDING
}

type OpenFinWindowEvent = keyof fin.OpenFinWindowEventMap;

interface Transaction {
    windows: ReadonlyArray<DesktopWindow>;
    remove: Debounced<() => void, typeof DesktopWindow, []>;
}

/**
 * The minimum change needed for a user initiated bounds change to be confirmed as a move or a resize. This will only be used
 * when display scaling is non-1, as in this case we can trust the transform type returned by the runtime
 */
const MINIMUM_RESIZE_CHANGE = 2;
const MINIMUM_MOVE_CHANGE = 2;

export class DesktopWindow implements DesktopEntity {
    public static readonly onCreated: Signal<[DesktopWindow]> = new Signal();
    public static readonly onDestroyed: Signal<[DesktopWindow]> = new Signal();

    /**
     * Tracks which windows are currently being manipulated as part of a transaction.
     *
     * This is used to identify and ignore group-changed events triggered by intermediate steps
     * of the transaction which may lead to out-of-sync state and general instability.
     */
    public static activeTransactions: Transaction[] = [];

    public static async getWindowState(window: Window): Promise<EntityState> {
        return Promise.all([window.getOptions(), window.getState(), window.getInfo(), window.isShowing(), window.getBounds()])
            .then((results: [fin.WindowOptions, string, WindowInfo, boolean, fin.WindowBounds]): EntityState => {
                const options: fin.WindowOptions = results[0];
                const state: WindowState = results[1] as WindowState;
                const info: WindowInfo = results[2];
                const isShowing: boolean = results[3];
                const bounds: fin.WindowBounds = results[4];
                const halfSize: Point = {x: bounds.width / 2, y: bounds.height / 2};
                const center: Point = {x: bounds.left + halfSize.x, y: bounds.top + halfSize.y};

                // Apply OS-specific offsets
                if (isWin10() && options.frame) {
                    halfSize.x -= 7;
                    halfSize.y -= 3.5;
                    center.y -= 3.5;
                }

                // Deal with undefined resizeRegion
                options.resizeRegion = options.resizeRegion || {sides: {}};

                // Map resize constraints to a more useful format
                const resizeConstraints: Point<ResizeConstraint> = {
                    x: {
                        resizableMin: !!options.resizable && (options.resizeRegion.sides.left !== false),
                        resizableMax: !!options.resizable && (options.resizeRegion.sides.right !== false),
                        minSize: options.minWidth || 0,
                        maxSize: options.maxWidth && options.maxWidth > 0 ? options.maxWidth : Number.MAX_SAFE_INTEGER
                    },
                    y: {
                        resizableMin: !!options.resizable && (options.resizeRegion.sides.top !== false),
                        resizableMax: !!options.resizable && (options.resizeRegion.sides.bottom !== false),
                        minSize: options.minHeight || 0,
                        maxSize: options.maxHeight && options.maxHeight > 0 ? options.maxHeight : Number.MAX_SAFE_INTEGER
                    }
                };

                // Get window title
                const {title, url} = info;
                let windowTitle = title;
                if (title && url && url.indexOf(title) >= 0) {
                    // The runtime will return (a subset of) the page URL as the title field if the document doesn't
                    // define a title. We would like to instead use the window name, to align with what is seen in the
                    // un-tabbed window frame.

                    // Current stable (13.76.44.21) behaviour is to return 'host+pathname+search+hash'. There is also a
                    // story (RUN-3457) to change this to 'host+pathname'. We will check for both of these strings, and
                    // revert to the window name if the title matches either
                    const parsedUrl = new URL(url);
                    const defaultTitles: string[] =
                        [[parsedUrl.host, parsedUrl.pathname, parsedUrl.search, parsedUrl.hash].join(''), [parsedUrl.host, parsedUrl.pathname].join('')];

                    if (defaultTitles.indexOf(title) >= 0) {
                        // Fall-back to window name
                        windowTitle = window.identity.name || '';
                    }
                }

                // Special handling for workspace placeholder windows
                if (window.identity.uuid === SERVICE_IDENTITY.uuid && window.identity.name && window.identity.name.startsWith('Placeholder-')) {
                    windowTitle = 'Loading...';
                }

                return {
                    center,
                    halfSize,
                    resizeConstraints,
                    frame: options.frame!,
                    hidden: !isShowing,
                    state,
                    icon: options.icon || `https://www.google.com/s2/favicons?domain=${options.url}`,
                    title: windowTitle,
                    showTaskbarIcon: options.showTaskbarIcon!,
                    opacity: options.opacity!,
                    alwaysOnTop: options.alwaysOnTop!,
                    maximizable: options.maximizable!
                };
            });
    }

    /**
     * Util for "pseudo-atomically" applying a set of window transformations, without the runtime applying window constraints as each window is modified.
     *
     * This util will break the given windows from their current window groups (whilst still preserving model state - snapGroup's, etc), then invoke the given
     * transformation on each window, and then re-group the windows once all transformations have been applied.
     *
     * @param windows The windows involved in the transaction
     * @param transform Promisified transformation function. Will be applied after all the windows have been detached from their previous window groups.
     */
    public static async transaction(windows: ReadonlyArray<DesktopWindow>, transform: (windows: ReadonlyArray<DesktopWindow>) => Promise<void>): Promise<void> {
        // Create a transaction object and add it to the active transactions list.
        // The 'remove' property looks a bit strange but effectively lets the object remove itself
        // from the list when prompted.
        const transaction: Transaction = {
            windows,
            remove: new Debounced(
                () => {
                    const indexToRemove = this.activeTransactions.indexOf(transaction);
                    if (indexToRemove >= 0) {
                        this.activeTransactions.splice(indexToRemove, 1);
                    }
                },
                this
            )
        };
        this.activeTransactions.push(transaction);
        try {
            await Promise.all(windows.map(w => w.sync()));
            await Promise.all(windows.map(w => w.unsnap()));
            // await Promise.all(windows.map(w => w.sync()));
            await transform(windows);
            await Promise.all(windows.map(w => w.snap()));
            // await Promise.all(windows.map(w => w.sync()));
        } finally {
            // We use the debounced here rather than removing it directly to allow time for
            // all related events to be handled.
            transaction.remove.call();
        }
    }

    private static isWindow(window: Window | fin.WindowOptions): window is Window {
        return window.hasOwnProperty('identity');
    }

    private static getIdentity(window: Window | fin.WindowOptions): WindowIdentity {
        if (this.isWindow(window)) {
            return window.identity as WindowIdentity;
        } else {
            return {uuid: SERVICE_IDENTITY.uuid, name: window.name!};
        }
    }

    /**
     * A window property has been changed that may snap the window out of any group that it it's currently in.
     *
     * The service should validate the window, to ensure it's current grouping is still valid.
     *
     * Arguments: (window: DesktopWindow)
     */
    public readonly onModified: Signal<[DesktopWindow]> = new Signal();

    /**
     * Window is being moved/resized, need to check for any snap targets.
     *
     * Arguments: (window: DesktopWindow, type: Mask<eTransformType>)
     */
    public readonly onTransform: Signal<[DesktopWindow, Mask<eTransformType>]> = new Signal();

    /**
     * The move/resize operation (that was signalled through onTransform) has been completed.
     *
     * Any active snap target can now be applied.
     *
     * Arguments: (window: DesktopWindow, type: Mask<eTransformType>)
     */
    public readonly onCommit: Signal<[DesktopWindow, Mask<eTransformType>]> = new Signal();

    /**
     * The tabGroup of the window has changed (including being set to null).
     *
     * Arguments: (window: DesktopWindow)
     */
    public readonly onTabGroupChanged: Signal<[DesktopWindow]> = new Signal();

    /**
     * Window is being removed from the service. Use this signal for any clean-up that is required, such as removing
     * the window from any groups, and the service as a whole.
     *
     * This may be because the window was closed (either by user-action, or programmatically), or because the window
     * has been deregistered.
     *
     * Arguments: (window: DesktopWindow)
     */
    public readonly onTeardown: Signal<[DesktopWindow], Promise<void>, Promise<void>> = new Signal(Aggregators.AWAIT_VOID);

    private _model: DesktopModel;
    private _identity: WindowIdentity;
    private _scope: WindowScope;
    private _id: string;  // Created from window uuid and name

    private _window: Window;

    /**
     * Cached state. Reflects the current state of the *actual* window object - basically, what you would get if you called any of the OpenFin API functions on
     * the window object.
     */
    private _currentState: EntityState;

    /**
     * What the application "thinks" the state of this window is. This is the state of the window, excluding any changes made to the window by the service.
     */
    private _applicationState: EntityState;

    /**
     * Lists all the modifications made to the window by the service. This is effectively a 'diff' between currentState and applicationState.
     */
    private _modifiedState: Partial<EntityState>;

    /**
     * A subset of modifiedState - changes made to the window on a very short-term basis, which will soon be reverted.
     *
     * When reverting, the property may go back to a value set by the application, or an earlier value set by the service.
     *
     * NOTE: The values within this object are the *previous* values of each property - what the property should be set to when reverting the temporary change.
     * The temporary value can be found by looking up the keys of this object within 'currentState'.
     */
    private _temporaryState: Partial<EntityState>;

    private _snapGroup: DesktopSnapGroup;
    private _tabGroup: DesktopTabGroup|null;
    private _prevGroup: DesktopSnapGroup|null;
    private _lifecycleStage: LifecycleStage;

    private _pendingActions: Promise<void>[];
    private _actionTags: WeakMap<Promise<void>, string>;

    // Tracks event listeners registered on the fin window for easier clean-up.
    private _registeredListeners: Map<OpenFinWindowEvent, (event: fin.OpenFinWindowEventMap[OpenFinWindowEvent]) => void> = new Map();

    private _moveInProgress = false;
    private _userInitiatedBoundsChange: BoundsChange|null;

    constructor(model: DesktopModel, window: fin.WindowOptions|Window, initialState?: EntityState) {
        const identity = DesktopWindow.getIdentity(window);

        this._model = model;
        this._identity = identity;
        this._scope = {level: 'window', ...identity};
        this._id = `${identity.uuid}/${identity.name!}`;
        this._pendingActions = [];
        this._actionTags = new WeakMap();

        this._lifecycleStage = LifecycleStage.STARTING;

        if (!DesktopWindow.isWindow(window)) {
            this._window = fin.Window.wrapSync({uuid: fin.Application.me.uuid, name: window.name});
            this.addPendingActions('Add window ' + this._id, fin.Window.create(window).then(async (window: Window) => {
                this._window = window;
                this._currentState = await DesktopWindow.getWindowState(window);
                this._applicationState = {...this._currentState};

                this._lifecycleStage = LifecycleStage.READY;
                this.addListeners();
            }));
        } else if (!initialState) {
            this._window = window as Window;
            this.addPendingActions('Fetch initial window state ' + this._id, DesktopWindow.getWindowState(this._window).then((state: EntityState) => {
                this._currentState = state;
                this._applicationState = {...this._currentState};

                this._lifecycleStage = LifecycleStage.READY;
                this.addListeners();
            }));
        } else {
            this._window = window as Window;
            this._lifecycleStage = LifecycleStage.READY;
        }

        if (!initialState) {
            initialState = this.createTemporaryState();
        }
        this._currentState = this.cloneState(initialState);
        this._applicationState = this.cloneState(initialState);
        this._modifiedState = {};
        this._temporaryState = {};
        this._snapGroup = new DesktopSnapGroup();
        this._tabGroup = null;
        this._prevGroup = null;
        this._snapGroup.addWindow(this);

        this._userInitiatedBoundsChange = null;

        if (this.isReady) {
            this.addListeners();
        }

        DesktopWindow.onCreated.emit(this);
    }

    /**
     * Removes this window from the model. This may happen because the window that this object wraps has been closed, or because an application is
     * de-registering this window from the service.
     *
     * That means that the window wrapped by this object may or may not exist at the point this is called. We attempt to capture this by having DesktopWindow
     * manage it's own destruction in the former case, so that it can mark itself as not-ready before starting the clean-up of the model.
     */
    public async teardown(): Promise<void> {
        this.cleanupListeners();

        // Must first clean-up any usage of this window
        if (this._tabGroup) {
            await this._tabGroup.removeTab(this);
        }

        if (this.isReady) {
            // Reset overrides
            const overrides = Object.keys(this._temporaryState) as (keyof EntityState)[];
            await Promise.all(overrides.map((property: keyof EntityState) => {
                return this.resetOverride(property);
            }));

            // Undock the window
            this._window.leaveGroup();
        }
        await this.onTeardown.emit(this);
        DesktopWindow.onDestroyed.emit(this);
        this._lifecycleStage = LifecycleStage.ENDING;
    }

    private createTemporaryState(): EntityState {
        return {
            center: {x: 500, y: 300},
            halfSize: {x: 200, y: 100},
            frame: false,
            hidden: false,
            state: 'normal',
            icon: '',
            title: '',
            showTaskbarIcon: true,
            resizeConstraints: {
                x: {minSize: 0, maxSize: Number.MAX_SAFE_INTEGER, resizableMin: true, resizableMax: true},
                y: {minSize: 0, maxSize: Number.MAX_SAFE_INTEGER, resizableMin: true, resizableMax: true}
            },
            opacity: 1,
            alwaysOnTop: false,
            maximizable: true
        };
    }

    public get [Symbol.toStringTag]() {
        return this._id;
    }

    public get id(): string {
        return this._id;
    }

    public get identity(): WindowIdentity {
        return this._identity;
    }

    public get scope(): WindowScope {
        return this._scope;
    }

    public get isReady(): boolean {
        return this._lifecycleStage === LifecycleStage.READY;
    }

    public get isActive(): boolean {
        const state: EntityState = this._currentState;
        return !state.hidden && (state.opacity > 0 || this.applicationState.opacity > 0) && state.state !== 'minimized';
    }

    /**
     * Returns the group that this window currently belongs to.
     *
     * Windows and groups have a bi-directional relationship. You will also find this window within the group's list
     * of windows.
     */
    public get snapGroup(): DesktopSnapGroup {
        return this._snapGroup;
    }

    public get tabGroup(): DesktopTabGroup|null {
        return this._tabGroup;
    }

    public get prevGroup(): DesktopSnapGroup|null {
        return this._prevGroup;
    }

    public get currentState(): EntityState {
        // Special handling to return apparent bounds for maximized windows
        if (this._currentState.state === 'maximized') {
            const currentMonitor = this._model.getMonitorByRect(this._currentState);
            return {...this._currentState, ...currentMonitor};
        }
        return this._currentState;
    }

    public get normalBounds(): Rectangle {
        return {center: this._currentState.center, halfSize: this._currentState.halfSize};
    }

    public get applicationState(): EntityState {
        return this._applicationState;
    }

    public get moveInProgress(): boolean {
        return this._moveInProgress;
    }

    /**
     * Moves this window into a different group. Has no effect if function is called with the group that this window
     * currently belongs to. This also handles removing the window from it's previous group.
     *
     * Windows and groups have a bi-directional relationship. Calling this method will also add the window to the
     * group.
     *
     * NOTE: Windows must always belong to a group, so there is no corresponding 'clear'/'remove' method. To remove a
     * window from a group, you must add it to a different group.
     *
     * @param group The group that this window should be added to
     * @param offset An offset to apply to this windows position (use this to ensure window is in correct position)
     * @param newHalfSize Can also simultaneously change the size of the window
     */
    public async setSnapGroup(group: DesktopSnapGroup): Promise<void> {
        if (group !== this._snapGroup) {
            const wasSnapped = this._snapGroup.windows.length > 1;

            // Update state synchronously
            this.addToSnapGroup(group);

            // Unsnap from any existing windows
            if (wasSnapped) {
                await this.unsnap();
            }

            // Snap to any other windows in the new group
            if (this._snapGroup.windows.length > 1) {
                await this.snap();
            }
        }

        return Promise.resolve();
    }

    public applyOffset(offset: Point, halfSize?: Point): Promise<void> {
        const delta: Partial<EntityState> = {};

        if (offset) {
            delta.center = {x: this._currentState.center.x + offset.x, y: this._currentState.center.y + offset.y};
        }
        if (halfSize) {
            delta.center = delta.center || {...this._currentState.center};
            delta.halfSize = halfSize;

            delta.center.x += halfSize.x - this._currentState.halfSize.x;
            delta.center.y += halfSize.y - this._currentState.halfSize.y;
        }

        return this.updateState(delta, ActionOrigin.SERVICE);
    }

    public setTabGroup(group: DesktopTabGroup|null): Promise<void> {
        if (group) {
            console.log('Added ' + this._id + ' to ' + group.id);
        } else if (this._tabGroup) {
            console.log('Removed ' + this._id + ' from ' + this._tabGroup.id);
        }

        this._tabGroup = group;

        this.onTabGroupChanged.emit(this);

        // Modify state for tabbed windows (except for tabstrip windows)
        if (this._identity.uuid !== SERVICE_IDENTITY.uuid && this.isReady) {
            if (group) {
                // Set tabbed windows to be non-maximizable
                const delta: Partial<EntityState> = {maximizable: false};
                return this.updateState(delta, ActionOrigin.SERVICE);
            } else if (this._currentState.maximizable !== this._applicationState.maximizable) {
                // Revert tabbed windows to be maximizable
                const delta: Partial<EntityState> = {maximizable: true};
                return this.updateState(delta, ActionOrigin.SERVICE);
            }
        }

        // Nothing to do
        return Promise.resolve();
    }

    public async sync(): Promise<void> {
        const MAX_AWAITS = 10;
        let awaitCount = 0;

        while (this._pendingActions.length > 0) {
            if (++awaitCount <= MAX_AWAITS) {
                // Wait for pending operations to finish
                await Promise.all(this._pendingActions);
            } else {
                // If we've looped this many times, we're probably in some kind of deadlock scenario
                return Promise.reject(new Error(`Couldn't sync ${this._id} after ${awaitCount} attempts`));
            }
        }
    }

    public refresh(): Promise<void> {
        const window: Window = this._window;

        if (this.isReady) {
            return DesktopWindow.getWindowState(window).then((state: EntityState) => {
                const appState: EntityState = this._applicationState;
                const modifications: Partial<EntityState> = {};
                let hasChanges = false;

                forEachProperty(state, (property) => {
                    if (this.isModified(property, appState, state) &&
                        (!this._modifiedState.hasOwnProperty(property) || this.isModified(property, this._modifiedState, state))) {
                        modifications[property] = state[property];
                        hasChanges = true;
                    }
                });

                if (hasChanges) {
                    console.log('Window refresh found changes: ', this._id, modifications);
                    return this.updateState(modifications, ActionOrigin.APPLICATION);
                } else {
                    console.log('Refreshed window, no changes were found', this._id);
                    return Promise.resolve();
                }
            });
        } else {
            return Promise.resolve();
        }
    }

    public async bringToFront(): Promise<void> {
        return this.addPendingActions('bringToFront ' + this._id, this._window.bringToFront());
    }

    public async setAsForeground(): Promise<void> {
        return this.addPendingActions('setAsForeground ' + this._id, this._window.setAsForeground());
    }

    public async close(): Promise<void> {
        this._lifecycleStage = LifecycleStage.ENDING;
        return this.addPendingActions('close ' + this._id, this._window.close(true));
    }

    public async applyProperties(properties: Partial<EntityState>): Promise<void> {
        this.updateState(properties, ActionOrigin.SERVICE);
    }

    public async applyOverride<K extends keyof EntityState>(property: K, value: EntityState[K]): Promise<void> {
        if (value !== this._currentState[property]) {
            return this.updateState({[property]: value}, ActionOrigin.SERVICE_TEMPORARY);
        }
    }

    public async resetOverride(property: keyof EntityState): Promise<void> {
        if (this._temporaryState.hasOwnProperty(property)) {
            const value = this._temporaryState[property]!;
            this._currentState[property] = value;
            return this.updateState({[property]: value}, ActionOrigin.SERVICE);  // TODO: Is this the right origin type?
        }
    }

    public async sendEvent<T extends LayoutsEvent>(event: T): Promise<void> {
        if (this._lifecycleStage === LifecycleStage.STARTING) {
            await this.sync();
        }

        if (this.isReady && apiHandler.isClientConnection(this.identity)) {
            return apiHandler.sendToClient(this._identity, EVENT_CHANNEL_TOPIC, event);
        }
    }

    public async maximize(): Promise<void> {
        return this.updateState({state: 'maximized'}, ActionOrigin.SERVICE);
    }

    public async minimize(): Promise<void> {
        return this.updateState({state: 'minimized'}, ActionOrigin.SERVICE);
    }

    public async restore(): Promise<void> {
        // Note that the actual end state following this may be 'maximized'
        return this.updateState({state: 'normal'}, ActionOrigin.SERVICE);
    }

    protected async addPendingActions(tag: string, actions: Promise<void>|Promise<void>[]): Promise<void> {
        if (actions instanceof Array) {
            this._pendingActions.push.apply(this._pendingActions, actions);
            actions.forEach((action: Promise<void>, index: number) => {
                this._actionTags.set(action, `${tag} (${index + 1} of ${actions.length})`);
                action.then(this.onActionComplete.bind(this, action));
            });

            if (actions.length > 1) {
                return Promise.all(actions).then(() => {});
            } else if (actions.length === 1) {
                return actions[0];
            }
        } else {
            this._pendingActions.push(actions);
            this._actionTags.set(actions, tag);
            actions.then(this.onActionComplete.bind(this, actions));
            return actions;
        }
    }

    private onActionComplete(action: Promise<void>): void {
        const index = this._pendingActions.indexOf(action);
        if (index >= 0) {
            this._pendingActions.splice(index, 1);
        } else {
            console.warn('Action completed but couldn\'t find it in pending action list');
        }
    }

    private cloneState(state: EntityState): EntityState {
        return {
            center: {...state.center},
            halfSize: {...state.halfSize},
            resizeConstraints: {x: {...state.resizeConstraints.x}, y: {...state.resizeConstraints.y}},
            ...state
        };
    }

    private isModified(key: keyof EntityState, prevState: Partial<EntityState>, newState: EntityState): boolean {
        if (prevState[key] === undefined) {
            return true;
        } else if (key === 'center' || key === 'halfSize') {
            const prevPoint: Point = prevState[key]!, newPoint: Point = newState[key];
            return prevPoint.x !== newPoint.x || prevPoint.y !== newPoint.y;
        } else if (key === 'resizeConstraints') {
            const prevConstraints: Point<ResizeConstraint> = prevState[key]!;
            const newConstraints: Point<ResizeConstraint> = newState[key];

            return (['x', 'y'] as (keyof Point)[]).some((dir: keyof Point) => {
                const a = prevConstraints[dir], b = newConstraints[dir];
                return a.minSize !== b.minSize || a.maxSize !== b.maxSize || a.resizableMin !== b.resizableMin || a.resizableMax !== b.resizableMax;
            });
        } else {
            return prevState[key] !== newState[key];
        }
    }

    private snap(): Promise<void> {
        const group: DesktopSnapGroup = this._snapGroup;
        const windows: DesktopWindow[] = this._snapGroup.windows as DesktopWindow[];
        const count = windows.length;
        const index = windows.indexOf(this);

        if (count >= 2 && index >= 0 && this.isReady) {
            const other: DesktopWindow = windows[index === 0 ? 1 : 0];

            // Merge window groups
            return Promise.all([this.sync(), other.sync()]).then(() => {
                const joinGroupPromise: Promise<void> = (async () => {
                    if (this.isReady && group === this._snapGroup) {
                        // It's possible that "other" has closed in the intervening time between registration of this pending
                        // action and its execution. If that is the case, we will roll over to the next window in the group
                        // until we find one that is groupable. If there are no groupable windows left in the group we will
                        // log a warning and not proceed with the snap.
                        let target: DesktopWindow|undefined;
                        if (other.isReady) {
                            target = other;
                        } else {
                            target = group.windows.find((item) => item.isReady && item !== this);
                        }

                        if (!target) {
                            console.warn('Found no ready windows when attempting to group window ', this.id);
                            return;
                        }

                        await this._window.mergeGroups(target._window).catch((error) => this.checkClose(error));

                        // Re-fetch window list in case it has changed during sync
                        const windows: DesktopWindow[] = this._snapGroup.windows as DesktopWindow[];

                        // Bring other windows in group to front
                        await windows.map(groupWindow => {
                            // Checks to make sure the window actually exists before bringing it to front. Fix for SERVICE-384
                            if (groupWindow.isReady) {
                                groupWindow._window.bringToFront();
                            } else {
                                console.warn('groupWindow is not ready. You may have a non-existent window in your snapGroup: ', groupWindow);
                            }
                        });
                    }
                })();

                return this.addPendingActions('snap - joinGroup', joinGroupPromise);
            });
        } else if (index === -1) {
            return Promise.reject(new Error('Attempting to snap, but window isn\'t in the target group'));
        } else {
            return Promise.reject(new Error('Need at least 2 windows in group to snap'));
        }
    }

    private checkClose(error: Error): void {
        if (error) {
            if (error.message.includes('Could not locate the requested window')) {
                // Pre-emptively clear ready flag to prevent future window interactions, but postpone teardown until 'handleClosed'.
                this._lifecycleStage = LifecycleStage.ENDING;
            } else {
                throw error;
            }
        }
    }

    private unsnap(): Promise<void> {
        // TODO: Wrap with 'addPendingActions'?..
        if (this.isReady) {
            return this._window.leaveGroup();
        } else {
            return Promise.resolve();
        }
    }

    private addToSnapGroup(group: DesktopSnapGroup): void {
        this._prevGroup = this._snapGroup;
        this._snapGroup = group;
        group.addWindow(this);
    }

    private async updateState(delta: Partial<EntityState>, origin: ActionOrigin): Promise<void> {
        const actions: Promise<void>[] = [];

        if (origin !== ActionOrigin.APPLICATION) {
            // Ensure we can modify window before we update our cache
            if (!this.isReady) {
                throw new Error('Cannot modify window, window not in ready state ' + this._id);
            }
        }

        // Update application state and modifications in comparison to application state
        if (origin === ActionOrigin.APPLICATION) {
            // Find changes from the application that weren't already known to the service
            forEachProperty(delta, (property) => {
                if (this.isModified(property, delta, this._currentState)) {
                    if (typeof delta[property] === 'object') {
                        Object.assign(this._applicationState[property], delta[property]);
                    } else {
                        this._applicationState[property] = delta[property]!;
                    }
                }
            });
        } else {
            // Track which properties have been modified by the service
            forEachProperty(delta, (property) => {
                if (this.isModified(property, delta, this._applicationState)) {
                    this._modifiedState[property] = delta[property];
                } else {
                    delete this._modifiedState[property];
                }
            });
        }

        // Update temporary values
        if (origin === ActionOrigin.SERVICE_TEMPORARY) {
            // Back-up existing values, so they can be restored later
            forEachProperty(delta, (property) => {
                if (!this._temporaryState.hasOwnProperty(property)) {
                    this._temporaryState[property] = this._currentState[property];
                }
            });
        } else {
            // Delete temporary values, as they've now been superceeded
            forEachProperty(delta, (property) => {
                if (this._temporaryState.hasOwnProperty(property)) {
                    delete this._temporaryState[property];
                }
            });
        }

        // Keep a copy of the previous state around temporarily to compare and avoid event loops.
        const prevState = this._currentState.state;
        const prevConstraints = this._currentState.resizeConstraints;
        Object.assign(this._currentState, delta);

        // Apply changes to the window (unless we're reacting to an external change that has already happened)
        if (origin !== ActionOrigin.APPLICATION) {
            const window = this._window;
            const {center, halfSize, state, hidden, resizeConstraints, ...options} = delta;
            const optionsToChange: (keyof EntityState)[] = Object.keys(options) as (keyof EntityState)[];

            // Apply visibility
            if (hidden !== undefined) {
                actions.push(hidden ? window.hide() : window.show());
            }

            // Apply window state
            if (state !== undefined && state !== prevState) {
                switch (state) {
                    case 'normal':
                        actions.push(window.restore());
                        break;
                    case 'minimized':
                        actions.push(window.minimize());
                        break;
                    case 'maximized':
                        actions.push(window.maximize());
                        break;
                    default:
                        console.warn('Invalid window state: ' + state);
                        break;
                }
            }

            // Apply bounds
            if (center || halfSize) {
                const state: EntityState = this._currentState;
                let newCenter = center || state.center, newHalfSize = halfSize || state.halfSize;

                if (isWin10() && state.frame) {
                    newCenter = {x: newCenter.x, y: newCenter.y + 3.5};
                    newHalfSize = {x: newHalfSize.x + 7, y: newHalfSize.y + 3.5};
                }

                const bounds = {left: newCenter.x - newHalfSize.x, top: newCenter.y - newHalfSize.y, width: newHalfSize.x * 2, height: newHalfSize.y * 2};
                actions.push(window.setBounds(bounds));
            }

            if (resizeConstraints) {
                // Work-around for RUN-5010. Cannot use -1 to reset maxWidth/Height as window becomes non-maximizable. Can use undefined to avoid maximizable
                // issue, but undefined won't reset constraints. Need to use -1 if clearing an actual constraint, undefined otherwise.
                const maxWidth = resizeConstraints.x.maxSize === Number.MAX_SAFE_INTEGER ?
                    (prevConstraints.x.maxSize === Number.MAX_SAFE_INTEGER ? undefined : -1) :
                    resizeConstraints.x.maxSize;
                const maxHeight = resizeConstraints.y.maxSize === Number.MAX_SAFE_INTEGER ?
                    (prevConstraints.y.maxSize === Number.MAX_SAFE_INTEGER ? undefined : -1) :
                    resizeConstraints.y.maxSize;

                actions.push(window.updateOptions({
                    resizable: resizeConstraints.x.resizableMin || resizeConstraints.x.resizableMax || resizeConstraints.y.resizableMin ||
                        resizeConstraints.y.resizableMax,
                    resizeRegion: {
                        sides: {
                            left: resizeConstraints.x.resizableMin,
                            right: resizeConstraints.x.resizableMax,
                            top: resizeConstraints.y.resizableMin,
                            bottom: resizeConstraints.y.resizableMax
                        }
                    },
                    minWidth: resizeConstraints.x.minSize,
                    minHeight: resizeConstraints.y.minSize,
                    maxWidth,
                    maxHeight
                }));
            }

            // Apply options
            if (optionsToChange.length > 0) {
                actions.push(window.updateOptions(options));
            }

            // Track these changes
            return this.addPendingActions('updateState ' + this._id + ' ' + JSON.stringify(delta), actions);
        }
    }

    /**
     * Windows 10 has a border shadow, which needs to be accounted for in window dimensions.
     *
     * If this window has a shadow, it's bounds will be enlarged accordingly.
     *
     * @param bounds Bounds that need to be validated
     */
    private checkBounds(bounds: fin.WindowBounds): fin.WindowBounds {
        if (isWin10() && this._currentState.frame) {
            return {left: bounds.left + 7, top: bounds.top, width: bounds.width - 14, height: bounds.height - 7};
        } else {
            return bounds;
        }
    }

    private addListeners(): void {
        this.registerListener('begin-user-bounds-changing', this.handleBeginUserBoundsChanging.bind(this));
        this.registerListener('bounds-changed', this.handleBoundsChanged.bind(this));
        this.registerListener('bounds-changing', this.handleBoundsChanging.bind(this));
        this.registerListener('closing', this.handleClosing.bind(this));
        this.registerListener('focused', this.handleFocused.bind(this));
        this.registerListener('group-changed', this.handleGroupChanged.bind(this));
        this.registerListener('hidden', () => this.updateState({hidden: true}, ActionOrigin.APPLICATION));
        this.registerListener('maximized', () => {
            this.updateState({state: 'maximized'}, ActionOrigin.APPLICATION);
            // Validate the group on maximize. This will ungroup the maximized window and
            // split the group as appropriate. Mitigation for SERVICE-375.
            this.snapGroup.validate();
        });
        this.registerListener('minimized', () => {
            this.updateState({state: 'minimized'}, ActionOrigin.APPLICATION);
            this._snapGroup.windows.forEach(window => {
                if (window !== this && !window.currentState.hidden) {
                    (window as DesktopWindow).applyProperties({state: 'minimized'});
                }
            });
        });
        this.registerListener('restored', () => {
            this.updateState({state: 'normal'}, ActionOrigin.APPLICATION);
            this._snapGroup.windows.forEach(window => {
                if (window !== this && !window.currentState.hidden) {
                    window.applyProperties({state: 'normal'});
                }
            });
        });
        this.registerListener('shown', () => this.updateState({hidden: false}, ActionOrigin.APPLICATION));
    }

    private registerListener<K extends OpenFinWindowEvent>(eventType: K, handler: (event: fin.OpenFinWindowEventMap[K]) => void) {
        this._window.addListener(eventType, handler);
        this._registeredListeners.set(eventType, handler);
    }

    private cleanupListeners(): void {
        const window: Window = this._window;

        for (const [key, listener] of this._registeredListeners) {
            window.removeListener(key, listener);
        }

        this._registeredListeners.clear();
    }

    private handleBoundsChanged(event: fin.WindowBoundsEvent): void {
        this._moveInProgress = false;

        const bounds: fin.WindowBounds = this.checkBounds(event);
        const halfSize: Point = {x: bounds.width / 2, y: bounds.height / 2};
        const center: Point = {x: bounds.left + halfSize.x, y: bounds.top + halfSize.y};

        let transformType: Mask<eTransformType>;

        if (this._userInitiatedBoundsChange) {
            transformType = this.updateTransformType(event, this._userInitiatedBoundsChange);
        }

        this.updateState({center, halfSize}, ActionOrigin.APPLICATION);

        if (this._userInitiatedBoundsChange) {
            this.onCommit.emit(this, transformType!);

            if (this._model.displayScaling) {
                this._snapGroup.restoreResizeConstraints();
            }
            // Setting this here instead of in 'end-user-bounds-changing' event to ensure we are still synced when this method is called.
            this._userInitiatedBoundsChange = null;
        } else {
            this.onModified.emit(this);
        }
    }

    private handleBoundsChanging(event: fin.WindowBoundsEvent): void {
        if (!this._moveInProgress) {
            this._moveInProgress = true;
        }

        const bounds: fin.WindowBounds = this.checkBounds(event);
        const halfSize: Point = {x: bounds.width / 2, y: bounds.height / 2};
        const center: Point = {x: bounds.left + halfSize.x, y: bounds.top + halfSize.y};

        let transformType: Mask<eTransformType>;

        if (this._userInitiatedBoundsChange) {
            transformType = this.updateTransformType(event, this._userInitiatedBoundsChange);
        }

        this.updateState({center, halfSize}, ActionOrigin.APPLICATION);

        if (this._userInitiatedBoundsChange) {
            this.onTransform.emit(this, transformType!);
        }
    }

    private updateTransformType(event: fin.WindowBoundsEvent, boundsChange: BoundsChange): Mask<eTransformType> {
        // If display scaling is enabled, distrust the changeType given by the runtime
        if (this._model.displayScaling) {
            const prevTransformType = boundsChange.transformType;

            const startBounds = boundsChange.startBounds;

            const bounds = this.checkBounds(event);
            const halfSize = {x: bounds.width / 2, y: bounds.height / 2};
            const center = {x: bounds.left + halfSize.x, y: bounds.top + halfSize.y};

            const evaluateAxis = (axis: 'x'|'y') => {
                const resize = Math.abs(halfSize[axis] - startBounds.halfSize[axis]) * 2 > MINIMUM_RESIZE_CHANGE;
                let expectedCenter: number;

                if (!resize) {
                    expectedCenter = startBounds.center[axis];
                } else {
                    const sizeChangeSign = Math.sign(halfSize[axis] - startBounds.halfSize[axis]);
                    // If start and new centers are equal, arbitrarily pick a sign, so as to not
                    // accidentally support 'symmetrical' resize from both edges
                    const centerChangeSign = Math.sign(center[axis] - startBounds.center[axis]) || 1;

                    const expectedEdgeChanged = sizeChangeSign * centerChangeSign;

                    expectedCenter = startBounds.center[axis] + expectedEdgeChanged * (halfSize[axis] - startBounds.halfSize[axis]);
                }

                const move = Math.abs(expectedCenter - center[axis]) > MINIMUM_MOVE_CHANGE;

                return (move ? eTransformType.MOVE : 0) | (resize ? eTransformType.RESIZE : 0);
            };

            boundsChange.transformType |= evaluateAxis('x');
            boundsChange.transformType |= evaluateAxis('y');

            // Err on the side of regarding transforms as purely moves
            if ((boundsChange.transformType & eTransformType.MOVE)) {
                boundsChange.transformType = eTransformType.MOVE;
            }

            const newTransformType = boundsChange.transformType;

            if (newTransformType === eTransformType.MOVE && prevTransformType !== eTransformType.MOVE) {
                this._snapGroup.suspendResizeConstraints();
            } else if (newTransformType !== eTransformType.MOVE && prevTransformType === eTransformType.MOVE) {
                this._snapGroup.restoreResizeConstraints();
            }

            return newTransformType;
        } else {
            // Convert 'changeType' into our enum type
            return event.changeType + 1;
        }
    }

    private handleBeginUserBoundsChanging(event: fin.WindowBoundsEvent) {
        const startBounds = {center: {...this.currentState.center}, halfSize: {...this.currentState.halfSize}};

        this._userInitiatedBoundsChange = {startBounds, transformType: 0};

        this.updateTransformType(event, this._userInitiatedBoundsChange);

        // Temporary extra validation to workaround runtime issues with windows right-click move
        // TODO: Removed once runtime has better handling of this edge case (RUN-5074?)
        // let disabled = false;
        // const disabledListener = () => {
        //     disabled = true;
        // };
        // this._window.once('bounds-changing', disabledListener);
        // this._window.once('bounds-changed', () => {
        //     if (!disabled && this._snapGroup.length > 1) {
        //         if (this._tabGroup) {
        //             this._tabGroup.validate();
        //         } else {
        //             this._snapGroup.validate();
        //         }
        //     }
        //     this._window.removeListener('bounds-changing', disabledListener);
        // });
    }

    private handleClosing(): void {
        // If 'onclose' event has fired, we shouldn't attempt to call any OpenFin API on the window.
        // Will immediately reset ready flag, to prevent any API calls as part of clean-up/destroy process.
        this._lifecycleStage = LifecycleStage.ENDING;

        // Clean-up model state
        this.teardown();
    }

    private async handleFocused(): Promise<void> {
        // If we're not maximized ourselves, bring all snapped, non-maximized windows to the front
        if (!this.isMaximizedOrInMaximizedTab()) {
            this._snapGroup.windows
                .filter(snapGroupWindow => snapGroupWindow !== this && !snapGroupWindow.isMaximizedOrInMaximizedTab() && !snapGroupWindow.currentState.hidden)
                .forEach(snapGroupWindow => snapGroupWindow.bringToFront());
        } else if (this._tabGroup && this._tabGroup.state === 'maximized') {
            this._snapGroup.windows
                .filter(snapGroupWindow => snapGroupWindow !== this && snapGroupWindow._tabGroup === this._tabGroup)
                .forEach(snapGroupWindow => snapGroupWindow.bringToFront());
        }
    }

    private async handleGroupChanged(event: fin.WindowGroupChangedEvent): Promise<void> {
        // Each group operation will raise an event from every window involved. To avoid handling the same event twice, we will only handle the event on the
        // window that triggered the event
        if (event.name !== event.sourceWindowName || event.uuid !== event.sourceWindowAppUuid) {
            return;
        }

        await this.sync();

        const targetWindow: DesktopWindow|null = this._model.getWindow({uuid: event.targetWindowAppUuid, name: event.targetWindowName});
        const targetGroup: DesktopSnapGroup|null = targetWindow ? targetWindow.snapGroup : null;

        // Ignore events for windows currently under a transaction, and if the transaction is over postpone
        // it's removal in case there are more events yet to be handled.
        const relevantTransactions =
            DesktopWindow.activeTransactions.filter((transaction: Transaction) => transaction.windows.some(w => !!targetWindow && w._id === targetWindow._id));
        if (relevantTransactions.length > 0) {
            console.log('Window currently in a transaction. Ignoring window group changed event: ', event);
            relevantTransactions.forEach(t => {
                t.remove.postpone();
            });
            return;
        }

        console.log('Received window group changed event: ', event);

        switch (event.reason) {
            case 'leave': {
                const modifiedSourceGroup = event.sourceGroup.concat({appUuid: this._identity.uuid, windowName: this._identity.name});
                if (this._snapGroup.length > 1 && compareSnapAndEventWindowArrays(this._snapGroup.windows, modifiedSourceGroup)) {
                    return this.setSnapGroup(new DesktopSnapGroup());
                } else {
                    return Promise.resolve();
                }
            }
            case 'join':
                if (targetWindow && targetGroup) {
                    return compareSnapAndEventWindowArrays(this._snapGroup.windows, event.targetGroup) ? Promise.resolve() : this.addToSnapGroup(targetGroup);
                }
                break;

            case 'merge':
                if (targetWindow && targetGroup) {
                    this._snapGroup.windows.forEach((window: DesktopEntity) => {  // TODO (SERVICE-200): Test snap groups that contain tabs
                        // Merge events are never triggered inside the service, so we do not need the same guards as join/leave
                        return window.setSnapGroup(targetGroup);
                    });
                }
                break;
            case 'disband':
                // We do nothing on disband since it is always in reaction to a leave/merge/join (which we will have acted on)
                break;

            default:
                console.warn('Received unexpected group event type: ' + event.reason + '. Expected valued are "leave", "join", "merge" or "disband".');
                break;
        }

        function compareSnapAndEventWindowArrays(snapWindows: DesktopEntity[], eventWindows: {appUuid: string, windowName: string}[]): boolean {
            return deepEqual(
                snapWindows.map(w => w.identity).sort((a, b) => a.uuid === b.uuid ? a.name.localeCompare(b.name) : a.uuid.localeCompare(b.uuid)),
                eventWindows.map(w => ({uuid: w.appUuid, name: w.windowName}))
                    .sort((a, b) => a.uuid === b.uuid ? a.name.localeCompare(b.name) : a.uuid.localeCompare(b.uuid))
            );
        }
    }

    private isMaximizedOrInMaximizedTab(): boolean {
        if (this._currentState.state === 'maximized') {
            return true;
        } else if (this._tabGroup !== null && this._tabGroup.state === 'maximized') {
            return true;
        } else {
            return false;
        }
    }
}
