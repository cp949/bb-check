export const createNpmInvocation = (
  npmExecPath: string | undefined,
  args: readonly string[],
) => {
  if (!npmExecPath) {
    throw new Error("npm_execpath가 없어 npm CLI를 실행할 수 없다");
  }

  return { command: process.execPath, args: [npmExecPath, ...args] };
};
