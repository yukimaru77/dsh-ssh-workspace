// OpenSSH transport: one multiplexed connection per host, key or agent auth only.
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";

export const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;

/** `[user@]host[:port][:path]`; a numeric segment after the host is the port. */
export function parseTarget(spec) {
	const value = String(spec ?? "").trim();
	if (!value) throw new Error("Usage: [user@]host[:port][:path]");
	const at = value.lastIndexOf("@", value.indexOf(":") < 0 ? value.length : value.indexOf(":"));
	const user = at > 0 ? value.slice(0, at) : undefined;
	const rest = at > 0 ? value.slice(at + 1) : value;
	const parts = rest.split(":");
	const host = parts.shift();
	if (!host || !/^[A-Za-z0-9._-]+$/.test(host)) throw new Error(`Invalid SSH host: ${host ?? ""}`);
	let port;
	if (parts.length && /^\d+$/.test(parts[0])) port = Number(parts.shift());
	const dir = parts.length ? parts.join(":") : undefined;
	return { user, host, port, path: dir || undefined };
}

export const describeTarget = (t) => `${t.user ? `${t.user}@` : ""}${t.host}${t.port ? `:${t.port}` : ""}`;

export function controlDir() {
	const dir = path.join(process.env.DSH_HOME || path.join(homedir(), ".dsh"), "ssh-workspace", "cm");
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	return dir;
}

export function sshArgs(target, remoteCommand) {
	return [
		"-o", "BatchMode=yes",
		"-o", "ConnectTimeout=15",
		"-o", "ControlMaster=auto",
		"-o", `ControlPath=${path.join(controlDir(), "%C")}`,
		"-o", "ControlPersist=600",
		...(target.port ? ["-p", String(target.port)] : []),
		...(target.user ? ["-l", target.user] : []),
		target.host,
		"--",
		remoteCommand,
	];
}

/** Start `bash -c <script>` (or a login shell, for user commands) on the host; the caller owns the child. */
export function spawnRemote(target, script, { login = false } = {}) {
	return spawn("ssh", sshArgs(target, `bash ${login ? "-lc" : "-c"} ${quote(script)}`), { stdio: ["pipe", "pipe", "pipe"] });
}

/** Run a remote script to completion and collect its output. */
export function runRemote(target, script, { input, signal, maxBytes = 64 * 1024 * 1024 } = {}) {
	return new Promise((resolve, reject) => {
		const child = spawnRemote(target, script);
		const out = [], err = [];
		let size = 0;
		const onAbort = () => child.kill("SIGTERM");
		signal?.addEventListener("abort", onAbort, { once: true });
		child.stdout.on("data", (chunk) => { size += chunk.length; if (size <= maxBytes) out.push(chunk); });
		child.stderr.on("data", (chunk) => err.push(chunk));
		child.on("error", reject);
		child.on("close", (code, sig) => {
			signal?.removeEventListener("abort", onAbort);
			if (signal?.aborted) return reject(new Error("SSH command aborted"));
			resolve({ code, signal: sig, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString("utf8"), overflow: size > maxBytes });
		});
		child.stdin.on("error", () => {});
		if (input !== undefined) child.stdin.end(input);
		else child.stdin.end();
	});
}

/** Like runRemote, but a nonzero exit throws with the remote error text (ssh's own failures are 255). */
export async function runRemoteOk(target, script, options) {
	const result = await runRemote(target, script, options);
	if (result.code !== 0) {
		const reason = result.stderr.trim() || `exit code ${result.code}`;
		throw new Error(result.code === 255 ? `SSH to ${describeTarget(target)} failed: ${reason}` : reason);
	}
	return result;
}
