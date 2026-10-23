/** Minimal flag parsing shared by the CLI entry points. */
export class Args {
  constructor(private argv: string[]) {}

  /** Value after `--name`, if given. */
  value(name: string): string | undefined {
    const i = this.argv.indexOf(`--${name}`);
    return i >= 0 ? this.argv[i + 1] : undefined;
  }

  has(name: string): boolean {
    return this.argv.includes(`--${name}`);
  }
}
