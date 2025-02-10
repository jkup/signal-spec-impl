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

// Add WatcherState type definition at the top with other types
type WatcherState = "watching" | "pending" | "waiting";

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
  equals?: (this: Signal<T>, t: T, t2: T) => boolean;
  [watchedSymbol]?: (this: Signal<T>) => void;
  [unwatchedSymbol]?: (this: Signal<T>) => void;
}

/**
 * Possible states for a Computed signal
 */
type ComputedState = "clean" | "checked" | "computing" | "dirty";

/**
 * Signal namespace containing State, Computed and subtle sub-namespaces
 */
export namespace Signal {
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
    #equals: (this: Signal<T>, t: T, t2: T) => boolean;
    #watched?: (this: Signal<T>) => void;
    #unwatched?: (this: Signal<T>) => void;
    #sinks: Set<Computed<any> | subtle.Watcher>;

    /**
     * Constructor Algorithm:
     * 1. Set this Signal's value to initialValue.
     * 2. Set this Signal's equals to options?.equals
     * 3. Set this Signal's watched to options?.[Signal.subtle.watched]
     * 4. Set this Signal's unwatched to options?.[Signal.subtle.unwatched]
     * 5. Set this Signal's sinks to the empty set
     */
    constructor(initialValue: T, options?: SignalOptions<T>) {
      this.#value = initialValue;
      this.#equals = options?.equals ?? Object.is;
      this.#watched = options?.[watchedSymbol];
      this.#unwatched = options?.[unwatchedSymbol];
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

      // If we're currently computing a signal, add this signal as a dependency
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

      // Run set Signal value algorithm
      if (this.#equals.call(this, this.#value, newValue)) {
        return; // Clean exit - no changes needed
      }

      this.#value = newValue;

      // Track exceptions from notify callbacks
      const exceptions: Error[] = [];

      // Mark all dependent signals as dirty/pending and collect watchers
      const watchersToNotify = new Set<subtle.Watcher>();

      for (const sink of this.#sinks) {
        if (sink instanceof Computed) {
          sink.markDirty();
        } else if (sink instanceof subtle.Watcher) {
          if (sink.isWatching()) {
            watchersToNotify.add(sink);
            sink.markPending();
          }
        }
      }

      // Notify watchers
      for (const watcher of watchersToNotify) {
        frozen = true;
        try {
          watcher.notify();
        } catch (e) {
          exceptions.push(e as Error);
        } finally {
          frozen = false;
        }
        watcher.markWaiting();
      }

      // If we collected any exceptions, throw them
      if (exceptions.length === 1) {
        throw exceptions[0];
      } else if (exceptions.length > 1) {
        throw new AggregateError(
          exceptions,
          "Multiple exceptions in notify callbacks"
        );
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
    #state: ComputedState = "dirty";
    #sources: Set<Signal<any>> = new Set();
    #sinks: Set<Computed<any> | subtle.Watcher> = new Set();
    #equals: (this: Signal<T>, t: T, t2: T) => boolean;
    #callback: () => T;

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

      if (this.#state === "computing") {
        throw new Error("Detected cyclic dependency in computed signal");
      }

      // Add ourselves as a dependency if we're being computed
      if (computing) {
        computing.addSource(this);
      }

      // If we're dirty or checked, we need to recompute
      if (this.#state === "dirty" || this.#state === "checked") {
        // Find the deepest, leftmost dirty signal
        const toRecompute = this.findDeepestDirtySource();

        // Recompute it
        if (toRecompute) {
          toRecompute.recompute();
        }
      }

      // At this point we should be clean
      if (this.#state !== "clean") {
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
     * Add source tracking
     * Adds a signal as a dependency of this computed
     */
    addSource(source: Signal<any>): void {
      this.#sources.add(source);
    }

    /**
     * Add state management
     * Marks this computed as dirty, requiring recomputation
     */
    markDirty(): void {
      if (this.#state === "clean") {
        this.#state = "dirty";

        // Mark all sinks as checked/pending
        for (const sink of this.#sinks) {
          if (sink instanceof Computed) {
            if (sink.#state === "clean") {
              sink.#state = "checked";
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
     * Internal method to find the deepest, leftmost dirty source
     */
    private findDeepestDirtySource(): Computed<any> | null {
      // Do a depth-first search through sources
      for (const source of this.#sources) {
        if (source instanceof Computed) {
          if (source.#state === "dirty") {
            return source;
          }
          if (source.#state !== "clean") {
            const deeperSource = source.findDeepestDirtySource();
            if (deeperSource) {
              return deeperSource;
            }
          }
        }
      }

      // If we're dirty, return ourselves
      return this.#state === "dirty" ? this : null;
    }

    /**
     * Internal method to recompute the value
     * Implements the "recalculate dirty computed Signal" algorithm
     */
    private recompute(): void {
      // Clear out sources and remove ourselves from their sinks
      for (const source of this.#sources) {
        if (source instanceof Computed || source instanceof State) {
          source.removeSink(this);
        }
      }
      this.#sources.clear();

      // Save previous computing context
      const prevComputing = computing;
      computing = this;

      // Mark that we're computing
      this.#state = "computing";

      try {
        // Run the callback to get new value
        const newValue = this.#callback.call(this);

        // Check if value changed
        if (!this.#equals.call(this, this.#value as T, newValue)) {
          this.#value = newValue;
          // Mark sinks as dirty
          for (const sink of this.#sinks) {
            if (sink instanceof Computed) {
              sink.markDirty();
            }
          }
        }

        this.#state = "clean";
      } catch (e) {
        // Store error to be rethrown on next get()
        this.#value = e as Error;
        this.#state = "clean";
      } finally {
        // Restore computing context
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
            throw new Error("Invalid signal provided to watch");
          }
        }

        // Add signals and set up watching
        for (const signal of signals) {
          if (!this.#signals.has(signal)) {
            this.#signals.add(signal);

            if (signal instanceof State || signal instanceof Computed) {
              signal.addSink(this);

              // Call watched callback if it exists
              const watchedCallback = (signal as any)[WATCHED];
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
            throw new Error(
              "Cannot unwatch a signal that is not being watched"
            );
          }
        }

        // Remove signals and clean up
        for (const signal of signals) {
          this.#signals.delete(signal);

          if (signal instanceof State || signal instanceof Computed) {
            signal.removeSink(this);

            // Call unwatched callback if it exists
            const unwatchedCallback = (signal as any)[UNWATCHED];
            if (unwatchedCallback) {
              frozen = true;
              try {
                unwatchedCallback.call(signal);
              } finally {
                frozen = false;
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
            const state = (signal as any).#state;
            return state === "dirty" || state === "pending";
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
        if (frozen) {
          throw new Error("Cannot notify during another notification");
        }
        this.#notifyCallback();
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
    export function currentComputed(): Computed<any> | null {
      return computing;
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
      throw new Error("Invalid argument to introspectSources");
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
      throw new Error("Invalid argument to introspectSinks");
    }

    /**
     * True if this signal is "live", in that it is watched by a Watcher,
     * or it is read by a Computed signal which is (recursively) live.
     */
    export function hasSinks(s: State<any> | Computed<any>): boolean {
      if (s instanceof State || s instanceof Computed) {
        return s._getSinks().size > 0;
      }
      throw new Error("Invalid argument to hasSinks");
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
      throw new Error("Invalid argument to hasSources");
    }

    // Export the symbols in subtle namespace too
    export const watched = WATCHED;
    export const unwatched = UNWATCHED;
  }
}
