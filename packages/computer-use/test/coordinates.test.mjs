import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

test(
  "native click/scroll coordinates use fresh window bounds and reject outside points",
  {
    skip: process.platform !== "win32",
  },
  () => {
    const helper = fileURLToPath(new URL("../src/coordinates.ps1", import.meta.url));
    const bounds = { x: 340, y: 180, width: 640, height: 480 };
    const requests = [
      { x: 350, y: 200, bounds },
      { x: 10, y: 20, coordinateSpace: "window", bounds },
      { x: 639, y: 479, coordinateSpace: "window", bounds },
      { x: 10, y: 20, coordinateSpace: "window", bounds: { ...bounds, x: -640, y: -120 } },
      { x: 10, y: 20, coordinateSpace: "window", bounds: { ...bounds, x: 700, y: 400 } },
      { x: -1, y: 20, coordinateSpace: "window", bounds },
      { x: 640, y: 20, coordinateSpace: "window", bounds },
      { x: 10, y: 480, coordinateSpace: "window", bounds },
      { x: 10, y: 20, coordinateSpace: "desktop", bounds },
      { x: 10, y: 20, coordinateSpace: "guess", bounds },
      { x: 10, y: 20, coordinateSpace: "window", bounds: { ...bounds, width: 0 } },
    ];
    const command = `
    $ErrorActionPreference = 'Stop'
    . '${helper.replaceAll("'", "''")}'
    $requests = ConvertFrom-Json ([Console]::In.ReadToEnd())
    $results = @(foreach ($request in $requests) {
      try {
          $point = Resolve-T3InputPoint $request.x $request.y $request.coordinateSpace $request.bounds
        @{ ok = $true; point = $point }
      } catch {
        @{ ok = $false; error = $_.Exception.Message }
      }
    })
    ConvertTo-Json -InputObject $results -Depth 5 -Compress
  `;
    const result = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", command],
      {
        input: JSON.stringify(requests),
        encoding: "utf8",
        windowsHide: true,
        timeout: 10_000,
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const actual = JSON.parse(result.stdout);
    assert.deepEqual(
      actual.slice(0, 5).map((item) => item.point),
      [
        { x: 350, y: 200 },
        { x: 350, y: 200 },
        { x: 979, y: 659 },
        { x: -630, y: -100 },
        { x: 710, y: 420 },
      ],
    );
    assert.ok(actual.slice(0, 5).every((item) => item.ok));
    assert.ok(actual.slice(5).every((item) => !item.ok && item.error));
  },
);
