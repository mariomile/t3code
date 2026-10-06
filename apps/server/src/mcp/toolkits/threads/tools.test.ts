import { expect, it } from "@effect/vitest";
import { Tool } from "effect/unstable/ai";

import { ThreadsToolkit } from "./tools.ts";

it("exports provider-compatible object schemas with described parameters", () => {
  for (const tool of Object.values(ThreadsToolkit.tools)) {
    const schema = Tool.getJsonSchema(tool) as {
      readonly type?: unknown;
      readonly properties?: Readonly<Record<string, { readonly description?: unknown }>>;
      readonly anyOf?: unknown;
    };
    expect(
      tool.description?.length ?? 0,
      `${tool.name} should have a useful description`,
    ).toBeGreaterThan(40);
    expect(schema.type, `${tool.name} must export a top-level object schema`).toBe("object");
    expect(schema.anyOf, `${tool.name} must not export a root anyOf`).toBeUndefined();
    for (const [field, fieldSchema] of Object.entries(schema.properties ?? {})) {
      expect(
        typeof fieldSchema.description,
        `${tool.name}.${field} should explain what data the agent must pass`,
      ).toBe("string");
    }
  }
});
