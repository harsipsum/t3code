import { assert, describe, it } from "@effect/vitest";

import { cloudPromptText, isSyncPrompt } from "./agent.ts";

describe("cloud prompt", () => {
  it("sends only the user's words, not T3's local instructions", () => {
    const text = cloudPromptText([
      {
        type: "text",
        text: "<t3_code_instructions>\n## T3 Code interaction mode: Default\n</t3_code_instructions>\n\n<user_request>\nFix the flaky test\n</user_request>",
      },
      { type: "text", text: "<runtime_info>In case you're asked: ...</runtime_info>" },
    ]);
    assert.equal(text, "Fix the flaky test");
  });

  it("treats T3's restart continuations as sync and leaves ordinary text alone", () => {
    assert.isTrue(isSyncPrompt("/sync"));
    assert.isTrue(isSyncPrompt("Continue where you left off."));
    assert.isTrue(
      isSyncPrompt(
        "Note: the T3 server restarted, and this background work was cancelled before it finished.\n- task: build\n\nContinue where you left off.",
      ),
    );
    assert.isFalse(isSyncPrompt("Summarize, then continue where you left off."));
    // After a restart T3 wraps its first prompt in instructions and appends runtime info.
    const restarted = cloudPromptText([
      {
        type: "text",
        text: "<t3_code_instructions>\n## T3 Code interaction mode: Default\n</t3_code_instructions>\n\n<user_request>\nContinue where you left off.\n</user_request>",
      },
      { type: "text", text: "<runtime_info>In case you're asked: ...</runtime_info>" },
    ]);
    assert.isTrue(isSyncPrompt(restarted));
  });
});
