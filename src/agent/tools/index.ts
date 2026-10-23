import { bash } from './bash';
import { editFile, listDir, readFile, writeFile } from './files';
import { search } from './search';
import type { Tool } from './types';

export const ALL_TOOLS: Tool[] = [readFile, writeFile, editFile, listDir, search, bash];

export function findTool(name: string): Tool | undefined {
  return ALL_TOOLS.find((t) => t.name === name);
}

export * from './types';
export { shellInfo } from './bash';
