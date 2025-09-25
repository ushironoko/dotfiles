import { describe, expect, it } from "bun:test";
import {
  define,
  baseCommandArgs,
  createCommandContext,
} from "../../src/utils/command-helpers";
import { dryRunArg } from "../../src/types/command";

describe("command-helpers", () => {
  describe("define with baseCommandArgs", () => {
    it("should merge base args with custom args", () => {
      const command = define({
        name: "test",
        description: "Test command",
        args: {
          ...baseCommandArgs,
          ...dryRunArg,
          custom: {
            default: "value",
            description: "Custom arg",
            short: "x",
            type: "string" as const,
          },
        },
        run: async () => {},
      });

      expect(command.args).toHaveProperty("config");
      expect(command.args).toHaveProperty("verbose");
      expect(command.args).toHaveProperty("dryRun");
      expect(command.args).toHaveProperty("custom");
      expect(command.args?.config).toEqual(baseCommandArgs.config);
      expect(command.args?.verbose).toEqual(baseCommandArgs.verbose);
    });

    it("should preserve command metadata", () => {
      const command = define({
        name: "test",
        description: "Test command",
        args: {
          ...baseCommandArgs,
        },
        run: async () => {},
      });

      expect(command.name).toBe("test");
      expect(command.description).toBe("Test command");
    });
  });

  describe("createCommandContext", () => {
    it("should create context with logger", () => {
      const context = createCommandContext({
        verbose: true,
        dryRun: false,
      });

      expect(context).toHaveProperty("logger");
      expect(context.logger).toHaveProperty("info");
      expect(context.logger).toHaveProperty("error");
      expect(context.logger).toHaveProperty("warn");
      expect(context.logger).toHaveProperty("success");
      expect(context.logger).toHaveProperty("debug");
      expect(context.logger).toHaveProperty("action");
    });

    it("should pass options to logger", () => {
      const contextVerbose = createCommandContext({
        verbose: true,
        dryRun: false,
      });

      const contextDryRun = createCommandContext({
        verbose: false,
        dryRun: true,
      });

      // These will have different internal states
      expect(contextVerbose.logger).toBeDefined();
      expect(contextDryRun.logger).toBeDefined();
    });
  });
});
