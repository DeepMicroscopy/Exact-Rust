/** Undo / redo of annotation edits. A command knows how to undo and redo itself against the server. */
export interface Command {
  label: string;
  undo(): Promise<void>;
  redo(): Promise<void>;
}

export class History {
  private done: Command[] = [];
  private undone: Command[] = [];
  private busy: Promise<void> = Promise.resolve();
  private listeners = new Set<() => void>();

  constructor(private limit = 200) {}

  get canUndo(): boolean {
    return this.done.length > 0;
  }
  get canRedo(): boolean {
    return this.undone.length > 0;
  }
  get undoLabel(): string | null {
    return this.done.at(-1)?.label ?? null;
  }
  get redoLabel(): string | null {
    return this.undone.at(-1)?.label ?? null;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Records a command that was just carried out; a new edit ends the redo chain. */
  push(cmd: Command): void {
    this.done.push(cmd);
    if (this.done.length > this.limit) this.done.shift();
    this.undone = [];
    this.emit();
  }

  clear(): void {
    this.done = [];
    this.undone = [];
    this.emit();
  }

  /** Runs one step after the previous one has finished; a failing step stays where it was and the error is thrown. */
  undo(): Promise<void> {
    return this.step(() => {
      const cmd = this.done.at(-1);
      if (!cmd) return undefined;
      return cmd.undo().then(() => {
        this.done.pop();
        this.undone.push(cmd);
      });
    });
  }

  redo(): Promise<void> {
    return this.step(() => {
      const cmd = this.undone.at(-1);
      if (!cmd) return undefined;
      return cmd.redo().then(() => {
        this.undone.pop();
        this.done.push(cmd);
      });
    });
  }

  private step(run: () => Promise<void> | undefined): Promise<void> {
    const next = this.busy.then(run).then(() => this.emit());
    this.busy = next.catch(() => undefined);
    return next;
  }

  private emit(): void {
    this.listeners.forEach((l) => l());
  }
}
