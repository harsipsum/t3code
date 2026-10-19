import { assert, describe, it } from "@effect/vitest";

import { cloudPrompt, isSyncPrompt } from "./agent.ts";

describe("cloud prompt", () => {
  it("keeps the user's words and the interaction mode, not T3's local tool instructions", () => {
    const prompt = cloudPrompt([
      {
        type: "text",
        text: "<t3_code_instructions>\n## T3 Code interaction mode: Plan\n\nDo not edit files.\n\n## T3 Code collaborative browser\n\nUse the browser tool.\n</t3_code_instructions>\n\n<user_request>\nExplain <user_request>tags</user_request> in this parser\n</user_request>",
      },
      { type: "text", text: "<runtime_info>In case you're asked: ...</runtime_info>" },
    ]);
    assert.equal(prompt.userText, "Explain <user_request>tags</user_request> in this parser");
    assert.equal(
      prompt.text,
      "Explain <user_request>tags</user_request> in this parser\n\n## T3 Code interaction mode: Plan\n\nDo not edit files.",
    );
  });

  it("sends an unwrapped follow-up exactly as typed", () => {
    const text = "Compare <user_request>a</user_request> with <user_request>b</user_request>";
    assert.equal(cloudPrompt([{ type: "text", text }]).text, text);
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
    const restarted = cloudPrompt([
      {
        type: "text",
        text: "<t3_code_instructions>\n## T3 Code interaction mode: Default\n</t3_code_instructions>\n\n<user_request>\nContinue where you left off.\n</user_request>",
      },
      { type: "text", text: "<runtime_info>In case you're asked: ...</runtime_info>" },
    ]);
    assert.isTrue(isSyncPrompt(restarted.userText));
  });
});
