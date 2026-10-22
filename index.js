// Switch one DSH session's workspace to an SSH host, like pi-ssh-remote: while
// connected, bash, read, write, edit, glob, grep, read_image and
// working_directory run on the host; the conversation, credentials and other
// tools stay local. Remote bash is a "bash" job, so the 10 s foreground wait,
// promotion, dsh-monitor reports and completion notices apply unchanged.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import * as path from "node:path";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { describeTarget, parseTarget, quote, runRemote, runRemoteOk, spawnRemote } from "./ssh.js";

export const name = "ssh-workspace";
export const inject = ["tools", "commands", "jobs", "systemPrompt"];

const ROUTED = new Set(["bash", "read", "write", "edit", "glob", "grep", "read_image", "working_directory"]);
const READ_LIMIT = 2000;
const MAX_TIMEOUT_MS = 600_000;
const OUTPUT_CAP = 256 * 1024;

const posix = path.posix;

function stateDir() {
	const dir = path.join(process.env.DSH_HOME || path.join(homedir(), ".dsh"), "ssh-workspace", "sessions");
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	return dir;
}
const stateFile = (sessionId) => path.join(stateDir(), `${createHash("sha256").update(String(sessionId)).digest("hex")}.json`);

export function apply(ctx, config = {}) {
	const sessions = new Map();
	const defaultTimeoutMs = config.timeoutMs ?? 10_000;

	/** The workspace of a session; resumed sessions restore it from disk. */
	function workspaceOf(sessionId) {
		if (sessionId === undefined) return undefined;
		if (sessions.has(sessionId)) return sessions.get(sessionId);
		let restored;
		try { restored = JSON.parse(readFileSync(stateFile(sessionId), "utf8")); } catch { /* local */ }
		sessions.set(sessionId, restored);
		return restored;
	}
	function save(sessionId, workspace) {
		sessions.set(sessionId, workspace);
		if (workspace) writeFileSync(stateFile(sessionId), JSON.stringify(workspace), { mode: 0o600 });
		else rmSync(stateFile(sessionId), { force: true });
	}

	async function connect(sessionId, spec) {
		const target = parseTarget(spec);
		const dir = target.path ?? "~";
		const into = dir === "~" ? 'cd "$HOME"' : dir.startsWith("~/") ? `cd "$HOME"/${quote(dir.slice(2))}` : `cd ${quote(dir)}`;
		const result = await runRemoteOk({ ...target }, `${into} && pwd && printf '%s\\n' "$HOME" && uname -s`);
		const [cwd, home, os] = result.stdout.toString("utf8").trim().split("\n");
		const workspace = { target: { user: target.user, host: target.host, port: target.port }, cwd, home, os };
		save(sessionId, workspace);
		return workspace;
	}
	async function changeDirectory(sessionId, workspace, dir) {
		const absolute = resolveRemote(workspace, dir);
		const result = await runRemoteOk(workspace.target, `cd ${quote(absolute)} && pwd`);
		const next = { ...workspace, cwd: result.stdout.toString("utf8").trim() };
		save(sessionId, next);
		return next;
	}
	const status = (workspace) => workspace
		? `SSH ${describeTarget(workspace.target)}:${workspace.cwd} (${workspace.os ?? "unix"}). bash, read, write, edit, glob, grep, read_image and working_directory run on this host.`
		: "Local workspace (not connected over SSH).";

	function resolveRemote(workspace, p) {
		const value = String(p ?? "").trim();
		if (!value) return workspace.cwd;
		if (value === "~") return workspace.home;
		if (value.startsWith("~/")) return posix.join(workspace.home, value.slice(2));
		return posix.isAbsolute(value) ? posix.normalize(value) : posix.join(workspace.cwd, value);
	}

	// ---- remote tool implementations; each returns the local tool's output value

	async function readFileRemote(workspace, file, signal) {
		const result = await runRemote(workspace.target, `cat -- ${quote(file)}`, { signal });
		if (result.code !== 0) return undefined;
		return result.stdout.toString("utf8");
	}
	async function writeFileRemote(workspace, file, content, signal) {
		const dir = posix.dirname(file);
		await runRemoteOk(workspace.target, `mkdir -p -- ${quote(dir)} && t=$(mktemp ${quote(`${dir}/.dsh-write.XXXXXX`)}) && cat > "$t" && { [ ! -e ${quote(file)} ] || chmod --reference=${quote(file)} "$t" 2>/dev/null || true; } && mv -f -- "$t" ${quote(file)}`, { input: content, signal });
	}

	const remote = {
		async read(args, exec, workspace) {
			const file = resolveRemote(workspace, args.file_path);
			const offset = args.offset ?? 1;
			const limit = Math.min(args.limit ?? READ_LIMIT, READ_LIMIT);
			const script = `[ -f ${quote(file)} ] || { echo "No such file: ${file.replaceAll('"', "")}" >&2; exit 2; }; awk -v s=${offset} -v e=${offset + limit - 1} 'NR>=s && NR<=e { print NR "\\t" $0 } END { print "\\036" NR }' ${quote(file)}`;
			const out = (await runRemoteOk(workspace.target, script, { signal: exec.signal })).stdout.toString("utf8");
			const marker = out.lastIndexOf("\x1e");
			const totalLines = Number(out.slice(marker + 1).trim()) || 0;
			const lines = out.slice(0, marker).split("\n").filter((line, i, all) => line.length > 0 || i < all.length - 1)
				.filter((line) => line.includes("\t")).map((line) => {
					const tab = line.indexOf("\t");
					return { number: Number(line.slice(0, tab)), text: line.slice(tab + 1) };
				});
			return { path: file, offset, lines, totalLines };
		},
		async write(args, exec, workspace) {
			const file = resolveRemote(workspace, args.file_path);
			const before = (await readFileRemote(workspace, file, exec.signal)) ?? null;
			await writeFileRemote(workspace, file, args.content, exec.signal);
			return { path: file, operation: before === null ? "create" : "update", before, after: args.content };
		},
		async edit(args, exec, workspace) {
			const file = resolveRemote(workspace, args.file_path);
			const before = await readFileRemote(workspace, file, exec.signal);
			if (before === undefined) throw new Error(`File not found: ${file}`);
			if (args.old_string === args.new_string) throw new Error("old_string and new_string must differ");
			const count = before.split(args.old_string).length - 1;
			if (count === 0) throw new Error("old_string was not found in the file");
			if (count > 1 && !args.replace_all) throw new Error(`old_string matches ${count} times; add surrounding context to make it unique, or set replace_all`);
			const after = args.replace_all ? before.split(args.old_string).join(args.new_string) : before.replace(args.old_string, () => args.new_string);
			await writeFileRemote(workspace, file, after, exec.signal);
			return { path: file, before, after };
		},
		async glob(args, exec, workspace) {
			const root = resolveRemote(workspace, args.path);
			// ripgrep when the host has it; otherwise list files and match the glob locally.
			const script = `cd ${quote(root)} || exit 2; if command -v rg >/dev/null; then echo RG; rg --files --glob=${quote(args.pattern)} --sort=modified --no-ignore --hidden 2>/dev/null | head -n 5000; else echo FIND; find . -type f -not -path '*/.git/*' 2>/dev/null | sed 's|^\\./||' | head -n 50000; fi`;
			const out = await runRemote(workspace.target, script, { signal: exec.signal });
			if (out.code === 2) throw new Error(`No such directory: ${root}`);
			const [mode, ...lines] = out.stdout.toString("utf8").split("\n").filter(Boolean);
			const paths = mode === "RG" ? lines : lines.filter((file) => posix.matchesGlob(file, args.pattern) || (!args.pattern.includes("/") && posix.matchesGlob(posix.basename(file), args.pattern))).slice(0, 5000);
			return { root, paths };
		},
		async grep(args, exec, workspace) {
			const where = resolveRemote(workspace, args.path);
			// Search from inside a directory so a symlinked root (macOS /tmp) is followed.
			const include = args.include ? quote(args.include) : "";
			const script = `if [ -d ${quote(where)} ]; then cd ${quote(where)} || exit 2; set -- .; else set -- ${quote(where)}; fi; `
				+ `if command -v rg >/dev/null; then rg --line-number --no-heading --with-filename --color=never ${include ? `--glob=${include} ` : ""}--regexp=${quote(args.pattern)} "$@"; `
				+ `else grep -rnIE -D skip ${include ? `--include=${include} ` : ""}-e ${quote(args.pattern)} "$@"; fi | head -n 2000`;
			const out = await runRemote(workspace.target, script, { signal: exec.signal });
			const matches = [];
			for (const line of out.stdout.toString("utf8").split("\n")) {
				const m = /^(.*?):(\d+):(.*)$/.exec(line);
				if (!m) continue;
				const file = posix.isAbsolute(m[1]) ? m[1] : posix.join(where, m[1]);
				matches.push({ path: file, lineNumber: Number(m[2]), line: m[3] });
			}
			return { matches };
		},
		async working_directory(args, exec, workspace, sessionId) {
			if (args.cd === undefined) return { cwd: workspace.cwd };
			return { cwd: (await changeDirectory(sessionId, workspace, args.cd)).cwd };
		},
		async bash(args, exec, workspace) {
			if (args.sandbox_permissions !== undefined) throw new Error("sandbox_permissions is not available on an SSH workspace");
			const cwd = args.workdir === undefined ? workspace.cwd : resolveRemote(workspace, args.workdir);
			const owner = exec.agent?.id;
			let child, code = null, sig = null, stdout = "", stderr = "";
			const id = ctx.jobs.start({
				kind: "bash",
				label: args.command,
				toolCall: { callId: exec.callId, rootCallId: exec.rootCallId },
				...(owner === undefined ? {} : { owner }),
				run: (job) => {
					child = spawnRemote(workspace.target, `cd ${quote(cwd)} && ${args.command}`, { login: true });
					child.stdin.end();
					child.stdout.setEncoding("utf8");
					child.stderr.setEncoding("utf8");
					child.stdout.on("data", (text) => { if (stdout.length < OUTPUT_CAP) stdout += text; job.append(text, { channel: "stdout" }); });
					child.stderr.on("data", (text) => { if (stderr.length < OUTPUT_CAP) stderr += text; job.append(text, { channel: "stderr" }); });
					const done = new Promise((resolve) => {
						child.on("error", (error) => resolve({ status: "failed", detail: error.message }));
						child.on("close", (exitCode, signal) => {
							code = exitCode; sig = signal;
							resolve({ status: exitCode === 0 ? "completed" : "failed", detail: signal ? `signal: ${signal}` : `exit code: ${exitCode}` });
						});
					});
					return { done, cancel: () => child?.kill("SIGTERM") };
				},
			});
			const remoteCwd = `ssh:${describeTarget(workspace.target)}:${cwd}`;
			if (args.run_in_background === true) return { kind: "background", jobId: id, cwd: remoteCwd };
			const timeoutMs = Math.min(args.timeoutMs ?? defaultTimeoutMs, MAX_TIMEOUT_MS);
			const view = await ctx.jobs.wait(id, timeoutMs, owner, exec.signal);
			if (view.status === "running" || view.status === "stopping") {
				const read = ctx.jobs.read(id, owner);
				return { kind: "promoted", cwd: remoteCwd, jobId: id, timeoutMs, output: read.chunks.filter((c) => c.channel !== "log").map((c) => c.text).join("") };
			}
			ctx.jobs.read(id, owner);
			try { ctx.jobs.remove(id, owner); } catch { /* already collected */ }
			return {
				kind: "foreground", cwd: remoteCwd, exitCode: code, signal: sig, timedOut: false, aborted: false, timeoutMs,
				stdout: { text: stdout, truncated: stdout.length >= OUTPUT_CAP }, stderr: { text: stderr, truncated: stderr.length >= OUTPUT_CAP },
			};
		},
		async read_image(args, exec, workspace) {
			const file = resolveRemote(workspace, args.file_path);
			const bytes = (await runRemoteOk(workspace.target, `cat -- ${quote(file)}`, { signal: exec.signal, maxBytes: 20 * 1024 * 1024 })).stdout;
			const dir = await mkdtemp(path.join(tmpdir(), "dsh-ssh-image-"));
			try {
				const local = path.join(dir, path.basename(file));
				await writeFile(local, bytes);
				const value = await ctx.tools.get("read_image", exec.agent).execute({ ...args, file_path: local }, exec);
				return { ...value, path: file };
			} finally { await rm(dir, { recursive: true, force: true }); }
		},
	};

	// Tell a connected session where its workspace really is; the working-directory
	// context above it still names the local directory.
	ctx.effect(() => ctx.systemPrompt.context({
		name: "ssh-workspace",
		order: ctx.systemPrompt.getContextOrder("WORKING_DIRECTORY") + 1,
		text: ({ scope }) => {
			const workspace = workspaceOf(scope?.id);
			if (!workspace) return "";
			return `SSH workspace is active on ${describeTarget(workspace.target)} (${workspace.os ?? "unix"}). The working directory for bash, read, write, edit, glob, grep, read_image and working_directory is ${workspace.cwd} on that host (home ${workspace.home}); the local working directory above does not apply to them. Use paths relative to ${workspace.cwd} or absolute paths on the host. Other tools stay local. ssh_exit returns to the local workspace.`;
		},
	}));

	// Route the workspace tools of connected sessions; everything else is untouched.
	ctx.on("tools/execute", async (exec, next) => {
		if (!ROUTED.has(exec.name)) return next();
		const sessionId = exec.agent?.id;
		const workspace = workspaceOf(sessionId);
		if (!workspace) return next();
		try {
			const value = await remote[exec.name](exec.arguments, exec, workspace, sessionId);
			const definition = ctx.tools.get(exec.name, exec.agent);
			return { isError: false, value, content: definition.output.render(exec.arguments, value) };
		} catch (error) {
			const message = `[SSH ${describeTarget(workspace.target)}] ${error instanceof Error ? error.message : String(error)}`;
			return { isError: true, error: { message }, content: [{ type: "text", text: message }] };
		}
	}, { prepend: true });

	// ---- controls: the same four as pi-ssh-remote, for the model and the user
	const text = { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: value }] };
	const sessionOf = (exec) => {
		if (!exec.agent) throw new Error("SSH controls need an owning DSH session.");
		return exec.agent.id;
	};
	const connected = (sessionId) => {
		const workspace = workspaceOf(sessionId);
		if (!workspace) throw new Error("Not connected over SSH. Use ssh_connect first.");
		return workspace;
	};
	ctx.effect(() => ctx.tools.register(defineTool({
		name: "ssh_connect",
		description: "Move this session's workspace to an SSH host (key or agent authentication only): bash, read, write, edit, glob, grep, read_image and working_directory then run there. Target: [user@]host[:port][:path], ~/.ssh/config aliases work. Switches directly from another host.",
		parameters: { target: { type: "string", required: true, description: "[user@]host[:port][:path]" } },
		output: text,
		async execute(args, exec) { return status(await connect(sessionOf(exec), args.target)); },
	})));
	ctx.effect(() => ctx.tools.register(defineTool({
		name: "ssh_exit",
		description: "Return this session to its local workspace.",
		parameters: {},
		output: text,
		async execute(_args, exec) { save(sessionOf(exec), undefined); return status(undefined); },
	})));
	ctx.effect(() => ctx.tools.register(defineTool({
		name: "ssh_cd",
		description: "Change the remote working directory without reconnecting.",
		parameters: { path: { type: "string", required: true, description: "Remote directory, absolute or relative to the current one." } },
		output: text,
		async execute(args, exec) {
			const sessionId = sessionOf(exec);
			return status(await changeDirectory(sessionId, connected(sessionId), args.path));
		},
	})));
	ctx.effect(() => ctx.tools.register(defineTool({
		name: "ssh_status",
		description: "Show whether this session works locally or on an SSH host, and where.",
		parameters: {},
		output: text,
		async execute(_args, exec) { return status(workspaceOf(sessionOf(exec))); },
	})));

	const run = (handler) => async (invocation) => {
		try { return { kind: "success", text: await handler(invocation.agent.id, invocation.rawInput.trim()) }; }
		catch (error) { return { kind: "error", text: error instanceof Error ? error.message : String(error) }; }
	};
	ctx.effect(() => ctx.commands.register({ name: "ssh-connect", description: "Move this session's workspace to an SSH host: /ssh-connect <[user@]host[:port][:path]>", input: { hint: "<[user@]host[:port][:path]>" }, handler: run(async (id, raw) => status(await connect(id, raw))) }));
	ctx.effect(() => ctx.commands.register({ name: "ssh-exit", description: "Return this session to its local workspace", handler: run(async (id) => { save(id, undefined); return status(undefined); }) }));
	ctx.effect(() => ctx.commands.register({ name: "ssh-cd", description: "Change the remote working directory: /ssh-cd <path>", input: { hint: "<remote-path>" }, handler: run(async (id, raw) => status(await changeDirectory(id, connected(id), raw))) }));
	ctx.effect(() => ctx.commands.register({ name: "ssh-status", description: "Show this session's workspace (local or SSH)", handler: run(async (id) => status(workspaceOf(id))) }));
}
