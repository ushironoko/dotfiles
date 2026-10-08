import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
  DefaultResourceLoader,
  ExtensionRunner,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ExtensionError,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";

export const createSdkExtensionRunner = async (
  extensionFactories: ExtensionFactory[],
  cwd: string,
  sessionManager = SessionManager.inMemory(cwd),
) => {
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: cwd,
    settingsManager: SettingsManager.inMemory(),
    extensionFactories,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  const loaded = await loader.loadProjectTrustExtensions();
  if (loaded.errors.length > 0) {
    throw new Error(JSON.stringify(loaded.errors));
  }
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  const runner = new ExtensionRunner(
    loaded.extensions,
    loaded.runtime,
    cwd,
    sessionManager,
    new ModelRegistry(modelRuntime),
  );
  const errors: ExtensionError[] = [];
  runner.onError((error) => errors.push(error));
  return { runner, sessionManager, errors };
};
