/**
 * Hidden global state:
 * - computing: The innermost computed or effect Signal currently being reevaluated due to a .get or .run call, or null. Initially null.
 * - frozen: Boolean denoting whether there is a callback currently executing which requires that the graph not be modified. Initially false.
 * - generation: An incrementing integer, starting at 0, used to track how current a value is while avoiding circularities.
 */

let computing: any = null;
let frozen: boolean = false;
let generation: number = 0;

// Define watched/unwatched symbols at the top level
declare const watchedSymbol: unique symbol;
declare const unwatchedSymbol: unique symbol;

export const WATCHED: typeof watchedSymbol = Symbol.for("watched") as any;
export const UNWATCHED: typeof unwatchedSymbol = Symbol.for("unwatched") as any;

// Add WatcherState type definition at the top level with other types
type WatcherState = "watching" | "pending" | "waiting";

/**
 * Flags for tracking signal states
 */
export const enum SignalFlags {
  Clean = 0,
  Computed = 1 << 0,
  Effect = 1 << 1,
  Tracking = 1 << 2,
  Computing = 1 << 3,
  Dirty = 1 << 4,
  Checked = 1 << 5,
  PendingComputed = 1 << 6,
  PendingEffect = 1 << 7,
  Notified = 1 << 8,
  Recursed = 1 << 9,
  Propagated = Dirty | PendingComputed | PendingEffect,
}

/**
 * Base Signal interface that both State and Computed implement
 */
export interface Signal<T> {
  get(): T;
}

/**
 * Options interface for Signal creation
 */
export interface SignalOptions<T> {
  [WATCHED]?: (this: Signal<T>) => void;
  [UNWATCHED]?: (this: Signal<T>) => void;
  equals?: (a: T, b: T) => boolean;
}

/**
 * Signal namespace containing State, Computed and subtle sub-namespaces
 */
export namespace Signal {
  /**
   * Propagates changes through the dependency graph using a depth-first traversal
   */
  function propagateChange(dep: State<any> | Computed<any>): void {
    let targetFlag = SignalFlags.Dirty;
    let subs = dep._getSinks();
    let stack = 0;
    let pendingWatchers: subtle.Watcher[] = [];

    top: do {
      for (const sink of subs) {
        const subFlags =
          sink instanceof Computed
            ? (sink as Computed<any>).hasFlag(
                SignalFlags.Tracking |
                  SignalFlags.Recursed |
                  SignalFlags.Propagated
              )
            : false;

        // Skip if already tracking or recursed
        if (subFlags) {
          continue;
        }

        // Handle computed signals
        if (sink instanceof Computed) {
          // Mark as notified and set target flag
          sink.setFlags(targetFlag | SignalFlags.Notified);

          // If this computed has sinks, traverse deeper
          const sinkSubs = sink._getSinks();
          if (sinkSubs.size > 0) {
            // If there are multiple sinks, we need to track our position for backtracking
            if (stack > 0) {
              targetFlag = SignalFlags.PendingComputed;
            }
            subs = sinkSubs;
            stack++;
            continue top;
          }
        }
        // Handle watchers
        else if (sink instanceof subtle.Watcher && sink.isWatching()) {
          sink.markPending();
          pendingWatchers.push(sink);
        }
      }

      // Backtrack
      while (stack > 0) {
        stack--;
        // Move back up to parent subs
        const parent =
          Array.from(subs)[0] instanceof Computed
            ? (Array.from(subs)[0] as Computed<any>)
                ._getSources()
                .values()
                .next().value
            : null;
        if (!parent) break;
        subs = parent._getSinks();
        targetFlag =
          stack > 0 ? SignalFlags.PendingComputed : SignalFlags.Dirty;
        continue top;
      }

      break;
    } while (true);

    // Notify watchers after all propagation is done
    for (const watcher of pendingWatchers) {
      watcher.notify();
    }
  }

  /**
   * State Signal Algorithm:
   * Internal slots:
   * - value: The current value of the state signal
   * - equals: The comparison function used when changing values
   * - watched: The callback to be called when the signal becomes observed by an effect
   * - unwatched: The callback to be called when the signal is no longer observed by an effect
   * - sinks: Set of watched signals which depend on this one
   */
  export class State<T> implements Signal<T> {
    #value: T;
    #equals: (a: T, b: T) => boolean;
    #watched?: (this: Signal<T>) => void;
    #unwatched?: (this: Signal<T>) => void;
    #sinks: Set<Computed<any> | subtle.Watcher>;

    /**
     * Constructor Algorithm:
     * 1. Set this Signal's value to initialValue.
     * 2. Set this Signal's watched to options?.[Signal.subtle.watched]
     * 3. Set this Signal's unwatched to options?.[Signal.subtle.unwatched]
     * 4. Set this Signal's sinks to the empty set
     */
    constructor(initialValue: T, options?: SignalOptions<T>) {
      this.#value = initialValue;
      this.#equals = options?.equals ?? Object.is;
      this.#watched = options?.[WATCHED];
      this.#unwatched = options?.[UNWATCHED];
      this.#sinks = new Set();
    }

    /**
     * get() Algorithm:
     * 1. If frozen is true, throw an exception.
     * 2. If computing is not undefined, add this Signal to computing's sources set.
     * 3. NOTE: We do not add computing to this Signal's sinks set until it is watched by a Watcher.
     * 4. Return this Signal's value.
     */
    get(): T {
      if (frozen) {
        throw new Error("Cannot read signals during notify callback");
      }

      if (computing) {
        computing.addSource(this);
      }

      return this.#value;
    }

    /**
     * set() Algorithm:
     * 1. If the current execution context is frozen, throw an exception.
     * 2. Run the "set Signal value" algorithm with this Signal and the first parameter for the value.
     * 3. If that algorithm returned ~clean~, then return undefined.
     * 4. Set the state of all sinks of this Signal to (if it is a Computed Signal) ~dirty~ if they were previously clean,
     *    or (if it is a Watcher) ~pending~ if it was previously ~watching~.
     * 5. Set the state of all of the sinks' Computed Signal dependencies (recursively) to ~checked~ if they were previously ~clean~
     *    (that is, leave dirty markings in place), or for Watchers, ~pending~ if previously ~watching~.
     * 6. For each previously ~watching~ Watcher encountered in that recursive search, then in depth-first order,
     *    1. Set frozen to true.
     *    2. Calling their notify callback (saving aside any exception thrown, but ignoring the return value of notify).
     *    3. Restore frozen to false.
     *    4. Set the state of the Watcher to ~waiting~.
     * 7. If any exception was thrown from the notify callbacks, propagate it to the caller after all notify callbacks have run.
     *    If there are multiple exceptions, then package them up together into an AggregateError and throw that.
     * 8. Return undefined.
     */
    set(newValue: T): void {
      if (frozen) {
        throw new Error("Cannot write signals during notify callback");
      }

      if (!this.#equals(this.#value, newValue)) {
        this.#value = newValue;

        // If we have sinks, propagate the change
        if (this.#sinks.size > 0) {
          propagateChange(this);
        }
      }
    }

    // Internal methods
    addSink(sink: Computed<any> | subtle.Watcher): void {
      this.#sinks.add(sink);
    }

    removeSink(sink: Computed<any> | subtle.Watcher): void {
      this.#sinks.delete(sink);
    }

    // Add accessor methods
    _getSinks(): Set<Computed<any> | subtle.Watcher> {
      return this.#sinks;
    }

    _getWatchedCallback(): ((this: Signal<T>) => void) | undefined {
      return this.#watched;
    }
  }

  /**
   * Computed Signal Algorithm:
   * Internal slots:
   * - value: The previous cached value of the Signal, or ~uninitialized~ for a never-read computed Signal
   * - state: May be ~clean~, ~checked~, ~computing~, or ~dirty~
   * - sources: An ordered set of Signals which this Signal depends on
   * - sinks: An ordered set of Signals which depend on this Signal
   * - equals: The equals method provided in the options
   * - callback: The callback which is called to get the computed Signal's value
   */
  export class Computed<T> implements Signal<T> {
    #value: T | Error | undefined = undefined;
    #flags: SignalFlags = SignalFlags.Dirty | SignalFlags.Computed;
    #sources: Set<Signal<any>> = new Set();
    #sinks: Set<Computed<any> | subtle.Watcher> = new Set();
    #callback: () => T;
    #equals: (a: T, b: T) => boolean;

    /**
     * Constructor Algorithm:
     * The constructor sets:
     * - callback to its first parameter
     * - equals based on options, defaulting to Object.is if absent
     * - state to ~dirty~
     * - value to ~uninitialized~
     */
    constructor(cb: () => T, options?: SignalOptions<T>) {
      this.#callback = cb;
      this.#equals = options?.equals ?? Object.is;
    }

    /**
     * get() Algorithm:
     * 1. If the current execution context is frozen or if this Signal has the state ~computing~,
     *    or if this signal is an Effect and computing a computed Signal, throw an exception.
     * 2. If computing is not null, add this Signal to computing's sources set.
     * 3. NOTE: We do not add computing to this Signal's sinks set until/unless it becomes watched by a Watcher.
     * 4. If this Signal's state is ~dirty~ or ~checked~: Repeat the following steps until this Signal is ~clean~:
     *    1. Recurse up via sources to find the deepest, left-most (i.e. earliest observed) recursive source which is a
     *       Computed Signal marked ~dirty~ (cutting off search when hitting a ~clean~ Computed Signal, and including this
     *       Computed Signal as the last thing to search).
     *    2. Perform the "recalculate dirty computed Signal" algorithm on that Signal.
     * 5. At this point, this Signal's state will be ~clean~, and no recursive sources will be ~dirty~ or ~checked~.
     *    Return the Signal's value. If the value is an exception, rethrow that exception.
     */
    get(): T {
      if (frozen) {
        throw new Error("Cannot read signals during notify callback");
      }

      if (this.#flags & SignalFlags.Computing) {
        throw new Error("Detected cyclic dependency in computed signal");
      }

      // Add ourselves as a dependency if we're being computed
      if (computing) {
        computing.addSource(this);
      }

      // If we're dirty or checked, we need to recompute
      if (this.#flags & (SignalFlags.Dirty | SignalFlags.Checked)) {
        // Find the deepest, leftmost dirty signal
        const toRecompute = this.findDeepestDirtySource();

        // Recompute it
        if (toRecompute) {
          toRecompute.recompute();
        }

        // If we're still dirty after recomputing dependencies, recompute ourselves
        if (this.#flags & (SignalFlags.Dirty | SignalFlags.Checked)) {
          this.recompute();
        }
      }

      // At this point we should be clean
      if (
        this.#flags &
        (SignalFlags.Dirty | SignalFlags.Computing | SignalFlags.Checked)
      ) {
        throw new Error(
          "Computed signal in unexpected state after recomputation"
        );
      }

      // If the value is an error, rethrow it
      if (this.#value instanceof Error) {
        throw this.#value;
      }

      return this.#value as T;
    }

    /**
     * Add state management
     * Marks this computed as dirty, requiring recomputation
     */
    markDirty(): void {
      if (!(this.#flags & SignalFlags.Dirty)) {
        this.#flags |= SignalFlags.Dirty;
        // Mark all sinks as checked/pending
        for (const sink of this.#sinks) {
          if (sink instanceof Computed) {
            if (!(sink.#flags & SignalFlags.Dirty)) {
              sink.#flags |= SignalFlags.Checked;
            }
          } else if (sink instanceof subtle.Watcher) {
            if (sink.isWatching()) {
              sink.markPending();
            }
          }
        }
      }
    }

    /**
     * Add source tracking
     * Adds a signal as a dependency of this computed
     */
    addSource(source: Signal<any>): void {
      this.#sources.add(source);
      if (source instanceof State || source instanceof Computed) {
        source.addSink(this);
      }
    }

    /**
     * Internal method to find the deepest, leftmost dirty source
     */
    private findDeepestDirtySource(): Computed<any> | null {
      // Do a depth-first search through sources
      for (const source of this.#sources) {
        if (source instanceof Computed) {
          if (source.#flags & SignalFlags.Dirty) {
            return source;
          }
          if (source.#flags & SignalFlags.Checked) {
            const deeperSource = source.findDeepestDirtySource();
            if (deeperSource) {
              return deeperSource;
            }
          }
        }
      }

      // If we're dirty, return ourselves
      return this.#flags & SignalFlags.Dirty ? this : null;
    }

    /**
     * Internal method to recompute the value
     * Implements the "recalculate dirty computed Signal" algorithm
     */
    private recompute(): void {
      // Clear all sources first
      for (const source of this.#sources) {
        if (source instanceof Computed || source instanceof State) {
          source.removeSink(this);
        }
      }
      this.#sources.clear();

      const prevComputing = computing;
      computing = this;

      this.#flags |= SignalFlags.Computing;

      try {
        const newValue = this.#callback.call(this);

        // Only update if value has changed according to equals function
        const valueChanged =
          this.#value === undefined ||
          this.#value instanceof Error ||
          !this.#equals(this.#value as T, newValue);

        if (valueChanged) {
          this.#value = newValue;
          // Mark all sinks as dirty/pending
          for (const sink of this.#sinks) {
            if (sink instanceof Computed) {
              sink.markDirty();
            } else if (sink instanceof subtle.Watcher) {
              sink.markPending();
            }
          }
        }

        this.#flags &= ~(
          SignalFlags.Computing |
          SignalFlags.Dirty |
          SignalFlags.Checked |
          SignalFlags.Notified
        );
      } catch (e) {
        this.#value = e instanceof Error ? e : new Error(String(e));
        this.#flags |= SignalFlags.Dirty;
        throw this.#value;
      } finally {
        computing = prevComputing;
      }
    }

    // Internal method for sink management
    addSink(sink: Computed<any> | subtle.Watcher): void {
      this.#sinks.add(sink);
    }

    removeSink(sink: Computed<any> | subtle.Watcher): void {
      this.#sinks.delete(sink);
    }

    // Add accessor methods
    _getSources(): Set<State<any> | Computed<any>> {
      return this.#sources as Set<State<any> | Computed<any>>;
    }

    _getSinks(): Set<Computed<any> | subtle.Watcher> {
      return this.#sinks;
    }

    // Add helper method to Computed class to check flags
    hasFlag(flag: SignalFlags): boolean {
      return (this.#flags & flag) !== 0;
    }

    setFlags(flags: SignalFlags): void {
      this.#flags |= flags;
    }
  }

  export namespace subtle {
    /**
     * Watcher class Algorithm:
     * Internal slots:
     * - state: May be ~watching~, ~pending~ or ~waiting~
     * - signals: An ordered set of Signals which this Watcher is watching
     * - notifyCallback: The callback which is called when something changes
     */
    export class Watcher {
      #state: WatcherState = "waiting";
      #signals: Set<Signal<any>> = new Set();
      #notifyCallback: () => void;
      #pendingNotify: boolean = false;

      /**
       * Constructor Algorithm:
       * 1. state is set to ~waiting~.
       * 2. Initialize signals as an empty set.
       * 3. notifyCallback is set to the callback parameter.
       */
      constructor(callback: () => void) {
        this.#notifyCallback = callback;
      }

      /**
       * watch() Algorithm:
       * 1. If frozen is true, throw an exception.
       * 2. If any of the arguments is not a signal, throw an exception.
       * 3. Append all arguments to the end of this object's signals.
       * 4. For each newly-watched signal, in left-to-right order,
       *    1. Add this watcher as a sink to that signal.
       *    2. If this was the first sink, then recurse up to sources to add that signal as a sink.
       *    3. Set frozen to true.
       *    4. Call the watched callback if it exists.
       *    5. Restore frozen to false.
       * 5. If the Signal's state is ~waiting~, then set it to ~watching~.
       */
      watch(...signals: Signal<any>[]): void {
        if (frozen) {
          throw new Error("Cannot modify watchers during notify callback");
        }

        // Validate all signals before modifying anything
        for (const signal of signals) {
          if (!(signal instanceof State || signal instanceof Computed)) {
            throw new TypeError("Invalid signal provided to watch");
          }
        }

        // Add signals and set up watching
        for (const signal of signals) {
          if (!this.#signals.has(signal)) {
            this.#signals.add(signal);

            if (signal instanceof State || signal instanceof Computed) {
              const wasEmpty = signal._getSinks().size === 0;
              signal.addSink(this);

              // For computed signals, establish dependencies and handle watched callbacks
              if (signal instanceof Computed) {
                // We need to evaluate to establish dependencies, but in an untracked context
                Signal.subtle.untrack(() => {
                  try {
                    signal.get();
                  } catch (e) {
                    // Ignore errors during initial evaluation
                  }
                });
              }

              // Call watched callback if it exists and this is the first sink
              if (wasEmpty && signal instanceof State) {
                const watchedCallback = signal._getWatchedCallback();
                if (watchedCallback) {
                  frozen = true;
                  try {
                    watchedCallback.call(signal);
                  } finally {
                    frozen = false;
                  }
                }
              }
            }
          }
        }

        // Update state if we have signals to watch
        if (this.#signals.size > 0 && this.#state === "waiting") {
          this.#state = "watching";
        }
      }

      /**
       * unwatch() Algorithm:
       * 1. If frozen is true, throw an exception.
       * 2. If any of the arguments is not a signal, or is not being watched by this watcher, throw an exception.
       * 3. For each signal in the arguments, in left-to-right order,
       *    1. Remove that signal from this Watcher's signals set.
       *    2. Remove this Watcher from that Signal's sink set.
       *    3. If that Signal's sink set has become empty, remove that Signal as a sink from each of its sources.
       *    4. Set frozen to true.
       *    5. Call the unwatched callback if it exists.
       *    6. Restore frozen to false.
       * 4. If the watcher now has no signals, and its state is ~watching~, then set it to ~waiting~.
       */
      unwatch(...signals: Signal<any>[]): void {
        if (frozen) {
          throw new Error("Cannot modify watchers during notify callback");
        }

        // Validate all signals before modifying anything
        for (const signal of signals) {
          if (!this.#signals.has(signal)) {
            throw new TypeError(
              "Cannot unwatch a signal that is not being watched"
            );
          }
        }

        // Remove signals and clean up
        for (const signal of signals) {
          this.#signals.delete(signal);

          if (signal instanceof State || signal instanceof Computed) {
            signal.removeSink(this);

            // Call unwatched callback if this was the last sink
            if (signal._getSinks().size === 0) {
              if (signal instanceof State) {
                const unwatchedCallback = signal._getWatchedCallback();
                if (unwatchedCallback) {
                  frozen = true;
                  try {
                    unwatchedCallback.call(signal);
                  } finally {
                    frozen = false;
                  }
                }
              }
              // Also handle unwatched callbacks for sources of computed signals
              if (signal instanceof Computed) {
                for (const source of signal._getSources()) {
                  if (
                    source instanceof State &&
                    source._getSinks().size === 0
                  ) {
                    const unwatchedCallback = (source as any)[UNWATCHED];
                    if (unwatchedCallback) {
                      frozen = true;
                      try {
                        unwatchedCallback.call(source);
                      } finally {
                        frozen = false;
                      }
                    }
                  }
                }
              }
            }
          }
        }

        // Update state if we have no more signals
        if (this.#signals.size === 0 && this.#state === "watching") {
          this.#state = "waiting";
        }
      }

      /**
       * getPending() Algorithm:
       * 1. Return an Array containing the subset of signals which are Computed Signals in the states ~dirty~ or ~pending~.
       */
      getPending(): Signal<any>[] {
        return Array.from(this.#signals).filter((signal) => {
          if (signal instanceof Computed) {
            return (signal as Computed<any>).hasFlag(
              SignalFlags.Dirty |
                SignalFlags.PendingComputed |
                SignalFlags.PendingEffect
            );
          }
          return false;
        });
      }

      /**
       * Check if the watcher is in watching state
       */
      isWatching(): boolean {
        return this.#state === "watching";
      }

      /**
       * Mark the watcher as pending (needs notification)
       */
      markPending(): void {
        if (this.#state === "watching") {
          this.#state = "pending";
        }
      }

      /**
       * Mark the watcher as waiting (notification handled)
       */
      markWaiting(): void {
        this.#state = "waiting";
      }

      /**
       * Notify callback execution
       */
      notify(): void {
        if (!this.#pendingNotify) {
          this.#pendingNotify = true;
          try {
            const prevFrozen = frozen;
            frozen = true;
            this.#notifyCallback.call(this);
          } finally {
            frozen = false;
            this.#pendingNotify = false;
            this.#state = "watching";
          }
        }
      }

      // Add accessor method
      _getSignals(): Set<State<any> | Computed<any>> {
        return this.#signals as Set<State<any> | Computed<any>>;
      }
    }

    /**
     * untrack() Algorithm:
     * 1. Let c be the execution context's current computing state.
     * 2. Set computing to null.
     * 3. Call cb.
     * 4. Restore computing to c (even if cb threw an exception).
     * 5. Return the return value of cb (rethrowing any exception).
     */
    export function untrack<T>(cb: () => T): T {
      const prevComputing = computing;
      computing = null;

      try {
        return cb();
      } finally {
        computing = prevComputing;
      }
    }

    /**
     * currentComputed() Algorithm:
     * 1. Return the current computing value.
     */
    export function currentComputed(): Computed<any> | undefined {
      return computing ?? undefined;
    }

    /**
     * Returns ordered list of all signals which this one referenced
     * during the last time it was evaluated.
     * For a Watcher, lists the set of signals which it is watching.
     */
    export function introspectSources(
      s: Computed<any> | Watcher
    ): (State<any> | Computed<any>)[] {
      if (s instanceof Watcher) {
        return Array.from(s._getSignals());
      } else if (s instanceof Computed) {
        return Array.from(s._getSources());
      }
      throw new TypeError("Invalid argument to introspectSources");
    }

    /**
     * Returns the Watchers that this signal is contained in, plus any
     * Computed signals which read this signal last time they were evaluated,
     * if that computed signal is (recursively) watched.
     */
    export function introspectSinks(
      s: State<any> | Computed<any>
    ): (Computed<any> | Watcher)[] {
      if (s instanceof State || s instanceof Computed) {
        return Array.from(s._getSinks());
      }
      throw new TypeError("Invalid argument to introspectSinks");
    }

    /**
     * True if this signal is "live", in that it is watched by a Watcher,
     * or it is read by a Computed signal which is (recursively) live.
     */
    export function hasSinks(s: State<any> | Computed<any>): boolean {
      if (s instanceof State || s instanceof Computed) {
        return s._getSinks().size > 0;
      }
      throw new TypeError("Invalid argument to hasSinks");
    }

    /**
     * True if this element is "reactive", in that it depends
     * on some other signal. A Computed where hasSources is false
     * will always return the same constant.
     */
    export function hasSources(s: Computed<any> | Watcher): boolean {
      if (s instanceof Watcher) {
        return s._getSignals().size > 0;
      } else if (s instanceof Computed) {
        return s._getSources().size > 0;
      }
      throw new TypeError("Invalid argument to hasSources");
    }

    // Export the symbols in subtle namespace too
    export const watched = WATCHED;
    export const unwatched = UNWATCHED;
  }

  // Add type guards at the top level
  export function isState(value: any): value is State<any> {
    return value instanceof State;
  }

  export function isComputed(value: any): value is Computed<any> {
    return value instanceof Computed;
  }
}
