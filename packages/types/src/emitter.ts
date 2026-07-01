/**
 * A host-agnostic typed event emitter — a minimal, dependency-free drop-in for
 * `vscode.EventEmitter`/`vscode.Event` so the portable core and its services can
 * expose and consume events without importing `vscode`.
 *
 * The shape mirrors VS Code's contract exactly: an emitter owns a `.event`
 * subscribe function, `.fire(value)` broadcasts, and `.dispose()` drops all
 * listeners. `EmitterDisposable` is structurally compatible with
 * `vscode.Disposable`, so a subscription can still be pushed into a
 * `context.subscriptions` array on the Category II side.
 *
 * Only use this for events consumed by our own code. Events handed *back* to a
 * VS Code API (e.g. `TreeDataProvider.onDidChangeTreeData`) must remain a real
 * `vscode.EventEmitter` — those live in the Category II adapter, not here.
 */

export interface EmitterDisposable {
	dispose(): void
}

export type Event<T> = (
	listener: (e: T) => unknown,
	thisArgs?: unknown,
	disposables?: EmitterDisposable[],
) => EmitterDisposable

export class TypedEmitter<T> {
	private readonly listeners = new Set<(e: T) => unknown>()

	readonly event: Event<T> = (listener, thisArgs, disposables) => {
		const bound = thisArgs ? (e: T) => listener.call(thisArgs, e) : listener
		this.listeners.add(bound)
		const disposable: EmitterDisposable = {
			dispose: () => {
				this.listeners.delete(bound)
			},
		}
		if (disposables) disposables.push(disposable)
		return disposable
	}

	fire(value: T): void {
		// Snapshot so a listener that (un)subscribes during dispatch can't perturb iteration.
		for (const listener of [...this.listeners]) {
			listener(value)
		}
	}

	dispose(): void {
		this.listeners.clear()
	}
}
