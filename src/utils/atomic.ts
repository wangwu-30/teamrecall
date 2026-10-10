import * as fs from "node:fs/promises";
import * as path from "node:path";

export async function writeAtomic(target: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  await fs.writeFile(temporary, content, "utf8");
  await fs.rename(temporary, target);
}

export async function readText(target: string): Promise<string> {
  try {
    const stat = await fs.stat(target);
    if (stat.isDirectory()) return "";
    return await fs.readFile(target, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

export async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await fs.stat(target)).isDirectory();
  } catch {
    return false;
  }
}

export async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

export function replaceManagedBlock(
  current: string,
  startMarker: string,
  endMarker: string,
  body: string,
): string {
  const start = current.indexOf(startMarker);
  const end = current.indexOf(endMarker);
  if ((start >= 0) !== (end >= 0) || (start >= 0 && end < start)) {
    throw new Error(`Malformed managed block: ${startMarker}`);
  }

  const block = `${startMarker}\n${body.trim()}\n${endMarker}`;
  if (start >= 0) {
    const after = end + endMarker.length;
    const next = `${current.slice(0, start)}${block}${current.slice(after)}`;
    return next.endsWith("\n") ? next : `${next}\n`;
  }

  if (!current) return `${block}\n`;
  const separator = current.endsWith("\n") ? (current.endsWith("\n\n") ? "" : "\n") : "\n\n";
  const next = `${current}${separator}${block}\n`;
  return next;
}
