import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

// Single-process development store. A production deployment must replace this with
// the scoped PostgreSQL adapter described by migrations/001_frontline.sql.
export class DevelopmentStore {
  constructor(path = process.env.FRONTLINE_DEV_STORE_PATH ?? resolve('work/frontline-dev-state.json')) {
    this.path = path;
    this.pending = Promise.resolve();
  }

  async read() {
    try {
      return JSON.parse(await readFile(this.path, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return { workspaces: {}, preparations: {}, knowledge: {}, agents: {}, demos: {}, requests: {}, workflows: {}, callerTurns: {}, outcomes: {}, cases: {}, lookups: {}, receipts: {} };
      throw error;
    }
  }

  async transaction(callback) {
    const operation = this.pending.then(async () => {
      const state = await this.read();
      const result = await callback(state);
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      const temporary = `${this.path}.${process.pid}.tmp`;
      await writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
      await rename(temporary, this.path);
      return result;
    });
    this.pending = operation.catch(() => {});
    return operation;
  }
}
