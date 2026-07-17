import { resolve } from "node:path";
import { assertLocalPiBaseline, type PiBaselineResult } from "./baseline";
import { compileExtensionsAgainstGlobalPi } from "./compile";
import { discoverPiInstallation, type PiInstallation } from "./installation";
import { smokeGlobalPiRpc } from "./rpc-smoke";

export interface PiCompatibilityResult {
  baseline: PiBaselineResult;
  installation: PiInstallation;
}

export interface PiCompatibilityDependencies {
  checkBaseline?: (repoRoot: string) => Promise<PiBaselineResult>;
  discover?: () => Promise<PiInstallation>;
  compile?: (installation: PiInstallation, repoRoot: string) => Promise<void>;
  smoke?: (installation: PiInstallation, repoRoot: string) => Promise<void>;
}

export const checkPiCompatibility = async (
  repoRoot: string = resolve(import.meta.dir, "../.."),
  dependencies: PiCompatibilityDependencies = {},
): Promise<PiCompatibilityResult> => {
  const checkBaseline =
    dependencies.checkBaseline ?? ((root) => assertLocalPiBaseline(root));
  const discover = dependencies.discover ?? (() => discoverPiInstallation());
  const compile =
    dependencies.compile ??
    ((installation, root) =>
      compileExtensionsAgainstGlobalPi(installation, { repoRoot: root }));
  const smoke =
    dependencies.smoke ??
    ((installation, root) =>
      smokeGlobalPiRpc(installation, { repoRoot: root }));

  const baseline = await checkBaseline(repoRoot);
  const installation = await discover();
  await compile(installation, repoRoot);
  await smoke(installation, repoRoot);
  return { baseline, installation };
};
