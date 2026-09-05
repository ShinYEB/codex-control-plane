// Native execution records only. Do not infer child process success from prose
// or parse arbitrary Python/JS wrappers as if their children were observed.
export function commandText(item) {
  const value = item?.command ?? item?.cmd ?? item?.input?.command ?? item?.result?.command;
  return Array.isArray(value) ? value.join(' ') : String(value ?? '');
}

export function commandExitCode(item) {
  return [item?.exitCode, item?.exit_code, item?.result?.exitCode, item?.result?.exit_code, item?.status?.exitCode]
    .find(Number.isInteger) ?? null;
}

export function commandSucceeded(item) {
  return commandExitCode(item) === 0 && !['failed','error','running','inprogress','in_progress'].includes(String(item?.status?.type ?? item?.status ?? '').toLowerCase());
}

export function isTestCommand(value, depth = 0) {
  const text = typeof value === 'string' ? value : commandText(value);
  // App Server serializes direct exec calls through the user's login shell.
  // Unwrap only that single command transport, never arbitrary scripts.
  const shell = text.match(/^(?:\/[^\s'"$`]+\/)?(?:zsh|bash|sh)\s+-(?:lc|cl|c)\s+(['"])([\s\S]*)\1$/);
  if (shell) {
    if (depth >= 2 || /[$`]/.test(shell[2])) return false;
    const inner = shell[1] === '"' ? shell[2].replace(/\\"/g, '"').replace(/\\\\/g, '\\') : shell[2];
    return isTestCommand(inner, depth + 1);
  }
  // Conservatively handle one invocation, with quoted executable paths. Shell
  // pipelines/compound statements require separate native command receipts.
  if (/[;|&\n`]/.test(text) || text.includes('$(')) return false;
  const tokens = text.match(/"[^"\n]*"|'[^'\n]*'|[^\s]+/g)?.map(t => t.replace(/^(['"])(.*)\1$/, '$2')) ?? [];
  const exe = (tokens.shift() ?? '').split(/[\\/]/).at(-1);
  if (['node','node.exe'].includes(exe)) {
    for (let i=0;i<tokens.length;i++) {
      const token=tokens[i];
      if (token === '--test') return true;
      if (['-e','--eval','-p','--print','--'].includes(token) || !token.startsWith('-')) return false;
      if (['--import','--loader','--require','-r'].includes(token)) i++;
    }
    return false;
  }
  if (['npm','pnpm','yarn'].includes(exe)) return tokens[0] === 'test' || (tokens[0] === 'run' && tokens[1] === 'test');
  if (['pytest','vitest','jest'].includes(exe)) return true;
  return ['cargo','go','xcodebuild'].includes(exe) && tokens[0] === 'test';
}

export function supersededTestFailure(item, later) {
  const cwd = item.cwd ?? item.workingDirectory ?? item.input?.cwd;
  if (!cwd || !isTestCommand(item)) return false;
  return later.some(next => commandSucceeded(next)
    && commandText(next) === commandText(item)
    && (next.cwd ?? next.workingDirectory ?? next.input?.cwd) === cwd);
}
