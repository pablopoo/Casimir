import pc from 'picocolors';

const tag = pc.bold(pc.blue('[void]'));

const timeFormat = new Intl.DateTimeFormat(undefined, {
  hour: 'numeric',
  minute: 'numeric',
  second: 'numeric',
});

let showTimestamp = true;

export function setShowTimestamp(value: boolean): void {
  showTimestamp = value;
}

function prefix(): string {
  if (!showTimestamp) {
    return tag;
  }
  return `${pc.dim(timeFormat.format())} ${tag}`;
}

export function voidLog(msg: string): void {
  console.log(`${prefix()} ${msg}`);
}

export function voidWarn(msg: string): void {
  console.log(`${prefix()} ${pc.yellow(msg)}`);
}

export function voidError(msg: string): void {
  console.log(`${prefix()} ${pc.red(msg)}`);
}
