import { mkdir, readFile, writeFile, access, copyFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Protocol metadata follows DeepSeek's official Codex integration. Instructions
// are this fork's own; no proprietary application implementation is included.
export const flashCatalog = {
  models: [
    {
      slug: "deepseek-flash",
      display_name: "DeepSeek Flash",
      description: "DeepSeek Flash with text, image and function tools.",
      prefer_websockets: false,
      support_verbosity: true,
      default_verbosity: "low",
      apply_patch_tool_type: "freeform",
      web_search_tool_type: "text",
      input_modalities: ["text", "image"],
      supports_image_detail_original: true,
      truncation_policy: { mode: "tokens", limit: 10000 },
      supports_parallel_tool_calls: true,
      tool_mode: null,
      multi_agent_version: "v2",
      use_responses_lite: false,
      include_skills_usage_instructions: false,
      auto_review_model_override: null,
      context_window: 1048576,
      max_context_window: 1048576,
      effective_context_window_percent: 95,
      auto_compact_token_limit: null,
      comp_hash: "3000",
      reasoning_summary_format: "experimental",
      default_reasoning_summary: "none",
      default_reasoning_level: "low",
      supported_reasoning_levels: [
        { effort: "low", description: "Faster responses" },
        { effort: "high", description: "More reasoning" },
        { effort: "max", description: "Maximum reasoning" },
      ],
      shell_type: "shell_command",
      visibility: "list",
      minimal_client_version: "0.144.0",
      supported_in_api: true,
      availability_nux: null,
      upgrade: null,
      priority: 1,
      experimental_supported_tools: [],
      supports_search_tool: false,
      default_service_tier: null,
      supports_reasoning_summaries: true,
      base_instructions:
        "You are a coding assistant running in T3 Code. Complete the user's requested work and verify the real result. Use the T3 preview tools for the in-app browser, and Open Harness CUA (open_harness_cua) for explicitly controlled Chrome tabs and Windows apps. Inspect before acting. Cookie exports require the user's explicit click in Chrome. Preserve existing work and keep credentials out of output.",
    },
  ],
};

const toml = (value) => JSON.stringify(value.replaceAll("\\", "/"));

async function localCodexBinary(root) {
  if (process.platform === "win32") {
    const architecture = process.arch === "arm64" ? "arm64" : "x64";
    const target = architecture === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc";
    const nativeBinary = path.join(
      root,
      ".t3",
      "codex-runtime",
      "node_modules",
      "@openai",
      `codex-win32-${architecture}`,
      "vendor",
      target,
      "bin",
      "codex.exe",
    );
    try {
      await access(nativeBinary);
      return nativeBinary;
    } catch {}
  }
  const binary = path.join(
    root,
    ".t3",
    "codex-runtime",
    "node_modules",
    ".bin",
    process.platform === "win32" ? "codex.cmd" : "codex",
  );
  try {
    await access(binary);
    return binary;
  } catch {
    return "codex";
  }
}

async function writeOnce(file, data) {
  try {
    await writeFile(file, data, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
}

export async function configureT3Cua({ root = repoRoot } = {}) {
  const binaryPath = await localCodexBinary(root);
  const t3Home = path.join(root, ".t3");
  const codexHome = path.join(t3Home, "deepseek-codex");
  const computerHome = path.join(t3Home, "computer-use");
  const electronHome = path.join(t3Home, "electron");
  const stateDir = path.join(t3Home, "userdata");
  for (const directory of [codexHome, computerHome, electronHome, stateDir]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
  }
  const catalogPath = path.join(codexHome, "models.json");
  await writeOnce(catalogPath, `${JSON.stringify(flashCatalog, null, 2)}\n`);
  const config = [
    'model = "deepseek-flash"',
    'model_provider = "deepseek"',
    'preferred_auth_method = "apikey"',
    'forced_login_method = "api"',
    'model_reasoning_effort = "low"',
    'web_search = "disabled"',
    `model_catalog_json = ${toml(catalogPath)}`,
    "",
    "[model_providers.deepseek]",
    'name = "DeepSeek"',
    'base_url = "https://api.deepseek.com/"',
    'wire_api = "responses"',
    'env_key = "DEEPSEEK_API_KEY"',
    "requires_openai_auth = false",
    "supports_websockets = false",
    "",
    "[mcp_servers.open_harness_cua]",
    `command = ${toml(process.execPath)}`,
    `args = [${toml(path.join(root, "packages/computer-use/src/server.mjs"))}]`,
    "startup_timeout_sec = 20",
    "tool_timeout_sec = 60",
    "",
    "[mcp_servers.open_harness_cua.env]",
    `OPEN_HARNESS_CUA_HOME = ${toml(computerHome)}`,
    "",
  ].join("\n");
  await writeOnce(path.join(codexHome, "config.toml"), config);

  const settingsPath = path.join(stateDir, "settings.json");
  let settings = {};
  try {
    settings = JSON.parse(await readFile(settingsPath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (settings === null || typeof settings !== "object" || Array.isArray(settings))
    throw new Error("Invalid T3 settings; existing file preserved.");
  if (!settings.providerInstances?.deepseek_flash) {
    settings.providerInstances = {
      ...settings.providerInstances,
      deepseek_flash: {
        driver: "codex",
        displayName: "DeepSeek Flash",
        enabled: true,
        environment: [{ name: "DEEPSEEK_API_KEY", value: "", sensitive: true }],
        config: {
          setupMode: "existing",
          binaryPath,
          homePath: codexHome,
          shadowHomePath: "",
          launchArgs: "",
          customModels: [
            {
              slug: "deepseek-flash",
              name: "DeepSeek Flash",
              capabilities: {
                optionDescriptors: [
                  {
                    id: "reasoningEffort",
                    label: "Reasoning",
                    type: "select",
                    currentValue: "low",
                    options: [
                      { id: "low", label: "Low", isDefault: true },
                      { id: "high", label: "High" },
                      { id: "max", label: "Max" },
                    ],
                  },
                ],
              },
            },
          ],
        },
      },
    };
    settings.defaultModelSelection ??= {
      instanceId: "deepseek_flash",
      model: "deepseek-flash",
      options: [{ id: "reasoningEffort", value: "low" }],
    };
    await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  } else if (
    settings.providerInstances.deepseek_flash.config?.binaryPath === "codex" &&
    binaryPath !== "codex"
  ) {
    settings.providerInstances.deepseek_flash.config.binaryPath = binaryPath;
    await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  }
  return { t3Home, codexHome, computerHome, electronHome, settingsPath };
}

/** Opt-in benchmark account. Copies auth locally without changing the signed-in home. */
export async function configureLunaAccount({
  root = repoRoot,
  sourceHome = path.join(os.homedir(), ".codex"),
} = {}) {
  const profile = await configureT3Cua({ root });
  const binaryPath = await localCodexBinary(root);
  const catalog = JSON.parse(await readFile(path.join(sourceHome, "models_cache.json"), "utf8"));
  const model = catalog.models?.find((entry) => entry.slug === "gpt-5.6-luna");
  if (!model || !model.supported_reasoning_levels?.some((level) => level.effort === "low")) {
    throw new Error(
      "GPT-5.6 Luna with low reasoning was not found in the signed-in account's catalog.",
    );
  }
  const lunaHome = path.join(profile.t3Home, "luna-codex");
  await mkdir(lunaHome, { recursive: true, mode: 0o700 });
  await copyFile(path.join(sourceHome, "auth.json"), path.join(lunaHome, "auth.json"), 1).catch(
    (error) => {
      if (error.code !== "EEXIST") throw error;
    },
  );
  await writeOnce(
    path.join(lunaHome, "models.json"),
    `${JSON.stringify({ models: [model] }, null, 2)}\n`,
  );
  await writeOnce(
    path.join(lunaHome, "config.toml"),
    [
      'model = "gpt-5.6-luna"',
      'model_reasoning_effort = "low"',
      `model_catalog_json = ${toml(path.join(lunaHome, "models.json"))}`,
      "",
      "[mcp_servers.open_harness_cua]",
      `command = ${toml(process.execPath)}`,
      `args = [${toml(path.join(root, "packages/computer-use/src/server.mjs"))}]`,
      "startup_timeout_sec = 20",
      "tool_timeout_sec = 60",
      "",
      "[mcp_servers.open_harness_cua.env]",
      `OPEN_HARNESS_CUA_HOME = ${toml(profile.computerHome)}`,
      "",
    ].join("\n"),
  );
  const settings = JSON.parse(await readFile(profile.settingsPath, "utf8"));
  if (!settings.providerInstances?.luna_low) {
    settings.providerInstances = {
      ...settings.providerInstances,
      luna_low: {
        driver: "codex",
        displayName: "GPT-5.6 Luna Low",
        enabled: true,
        config: {
          setupMode: "existing",
          binaryPath,
          homePath: lunaHome,
          shadowHomePath: "",
          launchArgs: "",
          customModels: [],
        },
      },
    };
    settings.defaultModelSelection = {
      instanceId: "luna_low",
      model: "gpt-5.6-luna",
      options: [{ id: "reasoningEffort", value: "low" }],
    };
    settings.textGenerationModelSelection = settings.defaultModelSelection;
    await writeFile(profile.settingsPath, `${JSON.stringify(settings, null, 2)}\n`, {
      mode: 0o600,
    });
  } else if (
    settings.providerInstances.luna_low.config?.binaryPath === "codex" &&
    binaryPath !== "codex"
  ) {
    settings.providerInstances.luna_low.config.binaryPath = binaryPath;
    await writeFile(profile.settingsPath, `${JSON.stringify(settings, null, 2)}\n`, {
      mode: 0o600,
    });
  }
  return { ...profile, lunaHome, model: model.slug };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const configured = process.argv.includes("--luna")
    ? await configureLunaAccount()
    : await configureT3Cua();
  console.log(`Open Harness CUA integration ready for T3 Code: ${configured.t3Home}`);
  if (configured.lunaHome)
    console.log(`Signed-in benchmark ready: ${configured.model}, low reasoning.`);
  else
    console.log(
      "Open Settings > Providers > DeepSeek Flash > Environment variables, enter DEEPSEEK_API_KEY, then save and refresh.",
    );
  await access(path.join(repoRoot, "apps/chrome-extension")).catch(() => {});
}
