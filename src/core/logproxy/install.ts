// install/uninstall のオーケストレーション（副作用は注入）。
// 安全不変条件: settings.json の env 有効化(writeEnv)は、health が 200 になったときだけ行う。
// プロキシが上がらなければ settings.json を触らず、壊れたプロキシが全 Claude Code を道連れにしない。

export interface InstallDeps {
  writePlist: () => Promise<string>;
  bootstrap: (plistPath: string) => Promise<void>;
  pollHealth: () => Promise<boolean>;
  writeEnv: () => Promise<void>;
  rollback: () => Promise<void>;
  log?: (msg: string) => void;
}

export interface InstallResult {
  ok: boolean;
  reason?: string;
}

export const runInstall = async (deps: InstallDeps): Promise<InstallResult> => {
  const log = deps.log ?? (() => {});
  const plistPath = await deps.writePlist();
  log(`plist written: ${plistPath}`);

  try {
    await deps.bootstrap(plistPath);
  } catch {
    await deps.rollback();
    return { ok: false, reason: "bootstrap failed" };
  }

  const healthy = await deps.pollHealth();
  if (!healthy) {
    await deps.rollback();
    return { ok: false, reason: "health check failed" };
  }

  // ここに来て初めて settings.json を書き換える
  await deps.writeEnv();
  log("global env enabled");
  return { ok: true };
};

export interface UninstallDeps {
  removeEnv: () => Promise<void>;
  bootout: () => Promise<void>;
  removePlist: () => Promise<void>;
}

export const runUninstall = async (deps: UninstallDeps): Promise<void> => {
  // 先に env を消して直結復帰させてから agent を停止・削除する
  await deps.removeEnv();
  await deps.bootout();
  await deps.removePlist();
};
