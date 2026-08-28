import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-fork-agent-smoke-"));
const packageDirectory = join(temporaryDirectory, "package");
const agentDirectory = join(temporaryDirectory, "agent");

function run(command, args, options) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			...options,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.once("error", reject);
		child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
	});
}

try {
	await mkdir(packageDirectory, { recursive: true });
	await mkdir(agentDirectory, { recursive: true });
	for (const relativePath of ["index.ts", "runner.mjs", "package.json"]) {
		await cp(join(root, relativePath), join(packageDirectory, basename(relativePath)));
	}

	// Deliberately omit node_modules. Pi Git packages are installed with dev
	// dependencies omitted, and Pi supplies core peer imports through its loader.
	const piCommand = process.platform === "win32" ? "pi.cmd" : "pi";
	const result = await run(
		piCommand,
		[
			"--offline",
			"--no-extensions",
			"--no-session",
			"--extension",
			join(packageDirectory, "index.ts"),
			"--print",
		],
		{
			cwd: packageDirectory,
			env: {
				...process.env,
				ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? "pi-fork-agent-smoke-test",
				PI_CODING_AGENT_DIR: agentDirectory,
				PI_OFFLINE: "1",
			},
		},
	);
	if (result.code !== 0) {
		const exit = result.signal ? `signal ${result.signal}` : `code ${result.code}`;
		const diagnostics = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join("\n");
		throw new Error(`Production extension smoke test exited with ${exit}${diagnostics ? `:\n${diagnostics}` : "."}`);
	}
} finally {
	await rm(temporaryDirectory, { recursive: true, force: true });
}
