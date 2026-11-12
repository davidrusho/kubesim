// The built-in image catalog and the tiny "container program" compiler.
// There are no real containers: each container runs a compiled Program of
// ops evaluated by the kubelet on sim time. Commands that touch files, the
// network or the environment compile to `run` ops, executed by exec.ts, the
// same engine `kubectl exec` and exec probes use.

import type { Container } from "./types";
import { fnv32a } from "./util";

export type Op =
  | { op: "log"; text: string }
  | { op: "sleep"; ms: number }
  | { op: "exit"; code: number }
  | { op: "serve" } // run forever, answering requests
  | { op: "jump"; to: number }
  /** Run a command through the exec engine; output goes to the container log. `when` gates on the last exit code (&&, ||). */
  | { op: "run"; argv: string[]; redirect?: { path: string; append: boolean }; when?: "ok" | "fail" }
  /** Hold memory (stress --vm). */
  | { op: "alloc"; bytes: number }
  /** Burn CPU (stress --cpu), in millicores. */
  | { op: "burn"; millicores: number }
  /** Start a `for` loop: set `var` to the first item (a word list, or `seq from to`), or skip to `end` if there are none. */
  | { op: "forinit"; var: string; items?: string[]; from?: number; to?: number; end: number }
  /** End of a `for` body: next item and jump back to `to`, else fall through. `init` is the forinit's index. */
  | { op: "fornext"; var: string; init: number; to: number }
  /** Jump if the last command succeeded (`ok`) or failed (`fail`): a while/until condition. */
  | { op: "jumpif"; when: "ok" | "fail"; to: number };

export type Program = Op[];

export interface HttpResponse {
  status: number;
  body: string;
  headers?: Record<string, string>;
}

export interface RequestContext {
  podName: string;
  podIP: string;
  port: number;
  path: string;
  query: Record<string, string>;
  clientIP: string;
  now: string; // formatted date
  args: string[];
  /** ms since the container started. */
  uptimeMs: number;
  /** Reads a file in the serving container. */
  read(path: string): string | undefined;
  /** Whether a directory exists in the serving container. */
  isDir?(path: string): boolean;
  host?: string;
}

export type Flavor = "busybox" | "gnu" | "none";

export interface ImageInfo {
  repo: string;
  tags: (tag: string) => boolean;
  sizeBytes: number;
  /** Program run when the Pod gives no command/args. */
  entrypoint(ctx: { env: Record<string, string>; args?: string[] }): Program;
  /** Responds to HTTP when serving; undefined means the port refuses HTTP. */
  http?(ctx: RequestContext): HttpResponse;
  /** Log line written per request served. */
  accessLog?(ctx: RequestContext, res: HttpResponse): string;
  /** Has a shell (sh -c works) and the usual tools. */
  shell: boolean;
  /** Which userland prints the error messages: BusyBox or GNU coreutils. */
  flavor: Flavor;
  defaultPort?: number;
  /** Ports the serving program listens on, from its args. Defaults to [defaultPort]. */
  ports?(args: string[]): number[];
  /** Files in the image layer. */
  files?: Record<string, string>;
  /** Exit code when stopped with SIGTERM (servers exit cleanly). */
  termExit?: number;
  /** Idle CPU in millicores, and CPU cost per request/s. */
  idleCpu?: number;
  cpuPerRps?: number;
  /** Time to answer one request when idle (ms), for the load model; 12 for HTTP, 2 for a database by default. */
  latencyMs?: number;
  /** Resident memory in bytes. */
  baseMem?: number;
  /** Dependencies it calls to serve a request to `path`, from its environment (URLs). */
  calls?(env: Record<string, string>, path: string): string[];
}

const Mi = 2 ** 20;
const semverish = (t: string) => /^v?\d+(\.\d+){0,2}(-[a-z0-9.]+)?$/.test(t);
const tagsIn =
  (...named: string[]) =>
  (t: string) =>
    named.includes(t) || semverish(t) || named.some((n) => n.endsWith("*") && t.startsWith(n.slice(0, -1)));

const NGINX_HTML = `<!DOCTYPE html>
<html>
<head>
<title>Welcome to nginx!</title>
</head>
<body>
<h1>Welcome to nginx!</h1>
<p>If you see this page, the nginx web server is successfully installed and
working. Further configuration is required.</p>
</body>
</html>`;

const nginxError = (code: number, text: string) => `<html>
<head><title>${code} ${text}</title></head>
<body>
<center><h1>${code} ${text}</h1></center>
<hr><center>nginx/1.27.5</center>
</body>
</html>`;

export const NGINX_404 = nginxError(404, "Not Found");
export const NGINX_503 = nginxError(503, "Service Temporarily Unavailable");

const nginxStartup = [
  "/docker-entrypoint.sh: /docker-entrypoint.d/ is not empty, will attempt to perform configuration",
  "/docker-entrypoint.sh: Looking for shell scripts in /docker-entrypoint.d/",
  "/docker-entrypoint.sh: Launching /docker-entrypoint.d/10-listen-on-ipv6-by-default.sh",
  "10-listen-on-ipv6-by-default.sh: info: Enabled listen on IPv6 in /etc/nginx/conf.d/default.conf",
  "/docker-entrypoint.sh: Configuration complete; ready for start up",
  "nginx: [notice] 1#1: using the \"epoll\" event method",
  "nginx: [notice] 1#1: start worker processes",
];

const accessLine = (c: RequestContext, res: HttpResponse) =>
  `${c.clientIP} - - [${c.now}] "GET ${c.path} HTTP/1.1" ${res.status} ${res.body.length} "-" "curl/8.5.0" "-"`;

const serveWith = (lines: string[], delayMs = 0): Program => [
  ...lines.map((text) => ({ op: "log" as const, text })),
  ...(delayMs ? [{ op: "sleep" as const, ms: delayMs }] : []),
  { op: "serve" },
];

/**
 * A static file server: maps the URL path under `root`, like nginx and httpd.
 * With `forbidden`, a directory that exists but has no index file answers 403,
 * as nginx does with autoindex off ("directory index of ... is forbidden").
 */
const staticFiles = (root: string, index: string, notFound: string, forbidden?: string) => (c: RequestContext): HttpResponse => {
  const p = c.path.split("?")[0];
  const file = p.endsWith("/") ? `${root}${p}${index}` : `${root}${p}`;
  const body = c.read(file) ?? (p.endsWith("/") ? undefined : c.read(`${file}/${index}`));
  if (body !== undefined) return { status: 200, body };
  const dir = p.endsWith("/") ? `${root}${p}` : `${root}${p}/`;
  if (forbidden && c.isDir?.(dir.replace(/\/+$/, "") || "/")) return { status: 403, body: forbidden };
  return { status: 404, body: notFound };
};

const shellImage = (repo: string, sizeBytes: number, extraTags: string[] = [], flavor: Flavor = "gnu"): ImageInfo => ({
  repo,
  tags: tagsIn("latest", ...extraTags),
  sizeBytes,
  shell: true,
  flavor,
  // Default CMD is an interactive shell with no stdin: it exits at once.
  entrypoint: () => [{ op: "exit", code: 0 }],
  idleCpu: 0,
  baseMem: 0.4 * Mi,
});

const hasEnv = (env: Record<string, string>, name: string) => !!env[name];
/** The URLs kubesim/demo-app calls: its *_URL environment variables, in name order. */
const demoCalls = (env: Record<string, string>) =>
  Object.keys(env)
    .filter((k) => k.endsWith("_URL") && /^(https?|postgres(ql)?|mysql|redis):\/\//.test(env[k]))
    .sort()
    .map((k) => env[k]);

/** The first digits of pi, computed once (Machin's formula) for the classic `perl bpi` Job. */
let piCache = "";
export function piDigits(n: number): string {
  if (piCache.length >= n + 2) return roundDigits(piCache, n);
  const digits = BigInt(n + 10);
  const unity = BigInt(10) ** digits;
  const arctan = (x: bigint) => {
    let sum = BigInt(0);
    let term = unity / x;
    const x2 = x * x;
    for (let k = BigInt(1), sign = BigInt(1); term !== BigInt(0); k += BigInt(2), sign = -sign) {
      sum += (sign * term) / k;
      term /= x2;
    }
    return sum;
  };
  const pi = BigInt(4) * (BigInt(4) * arctan(BigInt(5)) - arctan(BigInt(239)));
  piCache = pi.toString();
  return roundDigits(piCache, n);
}

/** n significant digits of the digit string (3141…), rounded half up like Math::BigFloat. */
function roundDigits(all: string, n: number): string {
  const digits = all.slice(0, n).split("").map(Number);
  if (Number(all[n]) >= 5) {
    for (let i = digits.length - 1; i >= 0; i--) {
      if (digits[i] < 9) {
        digits[i]++;
        break;
      }
      digits[i] = 0;
    }
  }
  const s = digits.join("");
  return `${s[0]}.${s.slice(1)}`;
}

/** The ports a kubeadm control-plane binary listens on, from its flags (so a probe on the wrong port fails as it does on a real node). */
const flagPorts = (args: string[], name: string, fallback: number[]) => {
  const v = args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  return v === undefined ? fallback : v.split(",").map((u) => parseInt(/:(\d+)(?:\/|$)/.exec(u)?.[1] ?? u, 10)).filter((n) => !isNaN(n));
};
const CONTROL_PLANE_PORTS: Record<string, (args: string[]) => number[]> = {
  "kube-apiserver": (a) => flagPorts(a, "secure-port", [6443]),
  "kube-controller-manager": (a) => flagPorts(a, "secure-port", [10257]),
  "kube-scheduler": (a) => flagPorts(a, "secure-port", [10259]),
  etcd: (a) => [...flagPorts(a, "listen-client-urls", [2379]), ...flagPorts(a, "listen-peer-urls", [2380]), ...flagPorts(a, "listen-metrics-urls", [])],
};
const CONTROL_PLANE_TAGS: Record<string, (tag: string) => boolean> = {
  "kube-apiserver": (t) => /^v1\.3[67]\.\d$/.test(t),
  "kube-controller-manager": (t) => /^v1\.3[67]\.\d$/.test(t),
  "kube-scheduler": (t) => /^v1\.3[67]\.\d$/.test(t),
  etcd: (t) => /^3\.[56]\.\d+-\d+$/.test(t),
};

export const IMAGES: ImageInfo[] = [
  {
    repo: "nginx",
    tags: tagsIn("latest", "stable", "mainline", "alpine", "stable-alpine", "mainline-alpine", "*-alpine", "*-perl"),
    sizeBytes: 72_188_133,
    shell: true,
    flavor: "gnu",
    defaultPort: 80,
    files: {
      "/usr/share/nginx/html/index.html": NGINX_HTML,
      "/usr/share/nginx/html/50x.html": nginxError(500, "Internal Server Error"),
      "/etc/nginx/conf.d/default.conf": "server {\n    listen       80;\n    server_name  localhost;\n    location / {\n        root   /usr/share/nginx/html;\n        index  index.html index.htm;\n    }\n}",
    },
    entrypoint: () => serveWith(nginxStartup),
    http: staticFiles("/usr/share/nginx/html", "index.html", NGINX_404, nginxError(403, "Forbidden")),
    accessLog: accessLine,
    termExit: 0,
    idleCpu: 1,
    cpuPerRps: 2,
    baseMem: 3 * Mi,
  },
  {
    repo: "httpd",
    tags: tagsIn("latest", "alpine"),
    sizeBytes: 58_120_010,
    shell: true,
    flavor: "gnu",
    defaultPort: 80,
    files: { "/usr/local/apache2/htdocs/index.html": "<html><body><h1>It works!</h1></body></html>" },
    entrypoint: () =>
      serveWith([
        "AH00558: httpd: Could not reliably determine the server's fully qualified domain name. Set the 'ServerName' directive globally to suppress this message",
        "[mpm_event:notice] [pid 1:tid 1] AH00489: Apache/2.4.62 (Unix) configured -- resuming normal operations",
      ]),
    http: staticFiles("/usr/local/apache2/htdocs", "index.html", "<!DOCTYPE HTML PUBLIC \"-//IETF//DTD HTML 2.0//EN\">\n<html><head>\n<title>404 Not Found</title>\n</head><body>\n<h1>Not Found</h1>\n<p>The requested URL was not found on this server.</p>\n</body></html>"),
    accessLog: (c, r) => `${c.clientIP} - - [${c.now}] "GET ${c.path} HTTP/1.1" ${r.status} ${r.body.length}`,
    termExit: 0,
    idleCpu: 1,
    cpuPerRps: 2,
    baseMem: 7 * Mi,
  },
  {
    repo: "nginxdemos/hello",
    tags: tagsIn("latest", "plain-text"),
    sizeBytes: 9_870_224,
    shell: true,
    flavor: "busybox",
    defaultPort: 80,
    entrypoint: () => serveWith(nginxStartup),
    http: (c) => ({
      status: 200,
      body: `Server address: ${c.podIP}:${c.port}\nServer name: ${c.podName}\nDate: ${c.now}\nURI: ${c.path}\nRequest ID: ${fnv32a(c.podName + c.now).toString(16).padStart(8, "0")}`,
    }),
    accessLog: accessLine,
    termExit: 0,
    idleCpu: 1,
    cpuPerRps: 2,
    baseMem: 2 * Mi,
  },
  {
    repo: "hashicorp/http-echo",
    tags: tagsIn("latest"),
    sizeBytes: 3_524_098,
    shell: false,
    flavor: "none",
    defaultPort: 5678,
    ports: (args) => {
      const l = args.find((a) => a.startsWith("-listen="));
      const p = l ? parseInt(l.split(":").pop()!, 10) : 5678;
      return [p];
    },
    entrypoint: ({ args }) => {
      const text = (args ?? []).find((a) => a.startsWith("-text="));
      if (!text) return [{ op: "log", text: "Missing -text option!" }, { op: "exit", code: 127 }];
      const l = (args ?? []).find((a) => a.startsWith("-listen="));
      return serveWith([`2026/01/01 09:00:00 [INFO] server is listening on ${l ? l.slice(8) : ":5678"}`]);
    },
    http: (c) => {
      const t = c.args.find((a) => a.startsWith("-text="))?.slice(6) ?? "";
      return { status: 200, body: t.replace(/^["']|["']$/g, "") };
    },
    accessLog: (c) => `2026/01/01 09:00:00 ${c.clientIP} | 200 |  GET ${c.path}`,
    termExit: 2,
    idleCpu: 1,
    cpuPerRps: 1,
    baseMem: 2 * Mi,
  },
  {
    repo: "gcr.io/google-samples/hello-app",
    tags: tagsIn("1.0", "2.0"),
    sizeBytes: 11_402_340,
    shell: false,
    flavor: "none",
    defaultPort: 8080,
    entrypoint: () => serveWith(["2026/01/01 09:00:00 Server listening on port 8080"]),
    http: (c) => ({ status: 200, body: `Hello, world!\nVersion: ${c.args.includes("__v2") ? "2.0.0" : "1.0.0"}\nHostname: ${c.podName}` }),
    accessLog: (c) => `2026/01/01 09:00:00 Serving request: ${c.path}`,
    termExit: 2,
    idleCpu: 1,
    cpuPerRps: 1,
    baseMem: 3 * Mi,
  },
  {
    repo: "registry.k8s.io/e2e-test-images/agnhost",
    tags: (t) => /^2\.\d+$/.test(t) || t === "latest",
    sizeBytes: 55_380_241,
    shell: true,
    flavor: "busybox",
    defaultPort: 8080,
    ports: (args) => {
      if (args[0] === "serve-hostname") return [9376];
      const p = args.find((a) => a.startsWith("--http-port="));
      return [p ? parseInt(p.slice(12), 10) : 8080];
    },
    entrypoint: ({ args }) => {
      const sub = args?.[0];
      if (sub === "liveness") return serveWith(["Started liveness server on :8080"]);
      if (sub === "netexec") return serveWith([`Started HTTP server on port ${(args ?? []).find((a) => a.startsWith("--http-port="))?.slice(12) ?? "8080"}`]);
      if (sub === "serve-hostname") return serveWith(["Serving on port 9376."]);
      if (sub === "pause") return serveWith(["Paused"]);
      return [
        { op: "log", text: "agnhost is a test image with many subcommands (liveness, netexec, serve-hostname, pause…)." },
        { op: "log", text: "Usage: agnhost [command]" },
        { op: "exit", code: 0 },
      ];
    },
    http: (c) => {
      const sub = c.args.find((a) => !a.startsWith("-") && !a.startsWith("/")) ?? c.args[0];
      const path = c.path.split("?")[0];
      if (sub === "liveness") {
        // Healthy for the first 10 seconds, then 500 forever (test/images/agnhost/liveness).
        if (path !== "/healthz") return { status: 404, body: "404 page not found" };
        const secs = c.uptimeMs / 1000;
        return secs < 10 ? { status: 200, body: "ok" } : { status: 500, body: `error: ${secs.toFixed(6)}` };
      }
      if (sub === "serve-hostname") return { status: 200, body: c.podName };
      if (path === "/hostname") return { status: 200, body: c.podName };
      if (path === "/echo") return { status: 200, body: c.query.msg ?? "" };
      if (path === "/clientip") return { status: 200, body: `${c.clientIP}:48320` };
      if (path === "/healthz" || path === "/readyz") return { status: 200, body: "ok" };
      if (path === "/") return { status: 200, body: `NOW: ${c.now}` };
      return { status: 404, body: "404 page not found" };
    },
    termExit: 2,
    idleCpu: 1,
    cpuPerRps: 1,
    baseMem: 8 * Mi,
  },
  {
    repo: "registry.k8s.io/hpa-example",
    tags: tagsIn("latest"),
    sizeBytes: 172_000_000,
    shell: true,
    flavor: "gnu",
    defaultPort: 80,
    entrypoint: () => serveWith(["[core:notice] [pid 1] AH00094: Command line: 'apache2 -D FOREGROUND'"]),
    // index.php runs a CPU-heavy loop for every request.
    http: () => ({ status: 200, body: "OK!" }),
    accessLog: (c) => `${c.clientIP} - - [${c.now}] "GET ${c.path} HTTP/1.1" 200 3`,
    termExit: 0,
    idleCpu: 1,
    cpuPerRps: 50,
    baseMem: 9 * Mi,
  },
  {
    // kubesim's own sample app (it exists only in the simulator). Like most real services it finds its
    // dependencies through environment variables: every *_URL (http, postgres, mysql, redis) is
    // called on each request, and if one is unreachable it answers 503 instead of 200.
    repo: "kubesim/demo-app",
    tags: (t) => t === "latest" || semverish(t),
    sizeBytes: 18_204_160,
    shell: false,
    flavor: "none",
    defaultPort: 8080,
    entrypoint: ({ env }) => serveWith([`demo-app ${env.APP_NAME ?? ""} listening on :8080`.replace("  ", " "), ...demoCalls(env).map((u) => `will call ${u.replace(/\/\/[^@/]*@/, "//")}`)]),
    http: (c) => ({ status: 200, body: `{"app":"demo-app","pod":"${c.podName}","path":"${c.path}"}` }),
    accessLog: (c, r) => `${c.clientIP} - "GET ${c.path}" ${r.status}${r.status >= 500 ? ` ${r.body}` : ""}`,
    // Health checks answer from the process itself, so a database outage doesn't take every Pod out of its Service.
    calls: (env, path) => (path.startsWith("/healthz") ? [] : demoCalls(env)),
    termExit: 0,
    idleCpu: 2,
    cpuPerRps: 3,
    baseMem: 14 * Mi,
  },
  {
    repo: "redis",
    tags: tagsIn("latest", "alpine"),
    sizeBytes: 45_012_778,
    shell: true,
    flavor: "gnu",
    defaultPort: 6379,
    entrypoint: () =>
      serveWith([
        "1:C 01 Jan 2026 09:00:00.000 * oO0OoO0OoO0Oo Redis is starting oO0OoO0OoO0Oo",
        "1:M 01 Jan 2026 09:00:00.001 * Running mode=standalone, port=6379.",
        "1:M 01 Jan 2026 09:00:00.002 * Server initialized",
        "1:M 01 Jan 2026 09:00:00.002 * Ready to accept connections tcp",
      ]),
    termExit: 0,
    idleCpu: 2,
    // Redis does tens of thousands of operations a second on one core.
    cpuPerRps: 0.05,
    latencyMs: 1,
    baseMem: 3 * Mi,
  },
  {
    repo: "postgres",
    tags: tagsIn("latest", "alpine"),
    sizeBytes: 158_392_120,
    shell: true,
    flavor: "gnu",
    defaultPort: 5432,
    entrypoint: ({ env }) =>
      hasEnv(env, "POSTGRES_PASSWORD")
        ? serveWith(
            ["The files belonging to this database system will be owned by user \"postgres\".", "PostgreSQL init process complete; ready for start up.", "LOG:  listening on IPv4 address \"0.0.0.0\", port 5432", "LOG:  database system is ready to accept connections"],
            4000,
          )
        : [
            { op: "log", text: "Error: Database is uninitialized and superuser password is not specified." },
            { op: "log", text: "       You must specify POSTGRES_PASSWORD to a non-empty value for the" },
            { op: "log", text: "       superuser. For example, \"-e POSTGRES_PASSWORD=password\" on \"docker run\"." },
            { op: "exit", code: 1 },
          ],
    termExit: 0,
    idleCpu: 5,
    // A simple indexed query costs a fraction of a millisecond of CPU.
    cpuPerRps: 0.3,
    latencyMs: 3,
    baseMem: 22 * Mi,
  },
  {
    repo: "mysql",
    tags: tagsIn("latest"),
    sizeBytes: 172_004_311,
    shell: true,
    flavor: "gnu",
    defaultPort: 3306,
    entrypoint: ({ env }) =>
      hasEnv(env, "MYSQL_ROOT_PASSWORD") || hasEnv(env, "MYSQL_ALLOW_EMPTY_PASSWORD") || hasEnv(env, "MYSQL_RANDOM_ROOT_PASSWORD")
        ? serveWith(["[Entrypoint]: Initializing database files", "[Server] /usr/sbin/mysqld: ready for connections. Version: '8.4.3'  socket: '/var/run/mysqld/mysqld.sock'  port: 3306"], 12000)
        : [
            { op: "log", text: "[ERROR] [Entrypoint]: Database is uninitialized and password option is not specified" },
            { op: "log", text: "    You need to specify one of the following as an environment variable:" },
            { op: "log", text: "    - MYSQL_ROOT_PASSWORD" },
            { op: "log", text: "    - MYSQL_ALLOW_EMPTY_PASSWORD" },
            { op: "log", text: "    - MYSQL_RANDOM_ROOT_PASSWORD" },
            { op: "exit", code: 1 },
          ],
    termExit: 0,
    idleCpu: 8,
    baseMem: 380 * Mi,
  },
  {
    repo: "polinux/stress",
    tags: tagsIn("latest"),
    sizeBytes: 9_744_175,
    shell: true,
    flavor: "busybox",
    entrypoint: ({ args }) => stressProgram(args ?? []),
    idleCpu: 0,
    baseMem: 0.5 * Mi,
  },
  {
    ...shellImage("perl", 342_000_000, ["slim", "*-slim"]),
  },
  shellImage("busybox", 2_167_176, ["musl", "glibc", "uclibc", "stable", "*-musl", "*-glibc", "*-uclibc"], "busybox"),
  shellImage("registry.k8s.io/busybox", 1_319_000, [], "busybox"),
  shellImage("curlimages/curl", 10_300_000, [], "busybox"),
  shellImage("alpine", 3_623_807, ["edge"], "busybox"),
  shellImage("ubuntu", 29_754_422, ["jammy", "noble", "focal"]),
  shellImage("debian", 48_494_272, ["bookworm", "bullseye", "stable-slim", "bookworm-slim"]),
  shellImage("python", 412_530_117, ["slim", "alpine", "*-slim", "*-alpine"]),
  shellImage("node", 398_122_004, ["lts", "slim", "alpine", "*-slim", "*-alpine"]),
  {
    repo: "registry.k8s.io/pause",
    tags: tagsIn("latest"),
    sizeBytes: 320_368,
    shell: false,
    flavor: "none",
    entrypoint: () => [{ op: "serve" }],
    baseMem: 0.3 * Mi,
  },
  ...(
    [
      ["etcd", 12, 38],
      ["kube-apiserver", 35, 240],
      ["kube-controller-manager", 12, 48],
      ["kube-scheduler", 3, 22],
      ["kube-proxy", 1, 14],
      ["coredns/coredns", 2, 14],
      ["metrics-server/metrics-server", 3, 18],
      ["ingress-nginx/controller", 2, 42],
    ] as const
  ).map(
    ([name, cpu, mem]): ImageInfo => ({
      repo: `registry.k8s.io/${name}`,
      // The control-plane images have a short, known tag list (a made-up patch version is ErrImagePull, as on the real registry).
      tags: CONTROL_PLANE_TAGS[name] ?? ((t) => /^v?\d/.test(t)),
      sizeBytes: 30_000_000,
      shell: false,
      flavor: "none",
      defaultPort: name === "ingress-nginx/controller" ? 80 : name === "coredns/coredns" ? 53 : name === "metrics-server/metrics-server" ? 10250 : undefined,
      ...(CONTROL_PLANE_PORTS[name] ? { ports: CONTROL_PLANE_PORTS[name] } : {}),
      entrypoint: () => [{ op: "serve" }],
      termExit: 0,
      idleCpu: cpu,
      baseMem: mem * Mi,
    }),
  ),
  {
    repo: "kindest/local-path-provisioner",
    tags: (t) => /^v?\d/.test(t),
    sizeBytes: 19_000_000,
    shell: false,
    flavor: "none",
    entrypoint: () => [{ op: "serve" }],
    termExit: 0,
    idleCpu: 1,
    baseMem: 9 * Mi,
  },
];

function stressProgram(args: string[]): Program {
  const val = (flag: string) => {
    const i = args.findIndex((a) => a === flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const vm = parseInt(val("--vm") ?? val("-m") ?? "0", 10) || 0;
  const cpu = parseInt(val("--cpu") ?? val("-c") ?? "0", 10) || 0;
  const vmBytes = parseSize(val("--vm-bytes") ?? "256M");
  const prog: Program = [{ op: "log", text: `stress: info: [1] dispatching hogs: ${cpu} cpu, 0 io, ${vm} vm, 0 hdd` }];
  if (vm) prog.push({ op: "alloc", bytes: vm * vmBytes });
  if (cpu) prog.push({ op: "burn", millicores: cpu * 1000 });
  prog.push({ op: "serve" });
  return prog;
}

function parseSize(s: string): number {
  const m = s.match(/^(\d+(?:\.\d+)?)([bkmgBKMG]?)$/);
  if (!m) return 256 * Mi;
  const mult = { "": 1, b: 1, k: 1024, m: Mi, g: 1024 * Mi }[m[2].toLowerCase() as "" | "b" | "k" | "m" | "g"];
  return parseFloat(m[1]) * mult;
}

export interface ImageRef {
  /** Canonical short repo, e.g. "nginx" or "nginxdemos/hello". */
  repo: string;
  tag: string;
  /** Fully-qualified reference as containerd reports it. */
  full: string;
}

export function parseImage(image: string): ImageRef {
  let ref = image.trim();
  let tag = "latest";
  const at = ref.indexOf("@");
  if (at >= 0) {
    tag = ref.slice(at + 1);
    ref = ref.slice(0, at);
  } else {
    const lastSlash = ref.lastIndexOf("/");
    const colon = ref.lastIndexOf(":");
    if (colon > lastSlash) {
      tag = ref.slice(colon + 1);
      ref = ref.slice(0, colon);
    }
  }
  let repo = ref.replace(/^docker\.io\//, "").replace(/^library\//, "");
  if (repo.startsWith("k8s.gcr.io/")) repo = repo.replace("k8s.gcr.io/", "registry.k8s.io/");
  const hasRegistry = /^[^/]+\.[^/]+\//.test(repo) || repo.startsWith("localhost");
  const full = hasRegistry ? `${repo}:${tag}` : `docker.io/${repo.includes("/") ? repo : `library/${repo}`}:${tag}`;
  return { repo, tag, full };
}

const lookups = new Map<string, { ref: ImageRef; info?: ImageInfo; tagOk: boolean }>();

export function lookupImage(image: string): { ref: ImageRef; info?: ImageInfo; tagOk: boolean } {
  const hit = lookups.get(image);
  if (hit) return hit;
  const ref = parseImage(image);
  const info = IMAGES.find((i) => i.repo === ref.repo);
  const tagOk = !!info && (ref.tag.startsWith("sha256:") || info.tags(ref.tag));
  const r = { ref, info, tagOk };
  if (lookups.size < 500) lookups.set(image, r);
  return r;
}

export function imageDigest(ref: ImageRef): string {
  const h = fnv32a(ref.full).toString(16).padStart(8, "0");
  return `${ref.full.replace(/:[^:/]+$/, "")}@sha256:${h.repeat(8)}`;
}

export function pullError(ref: ImageRef, info: ImageInfo | undefined): string {
  if (!info) {
    return `failed to pull and unpack image "${ref.full}": failed to resolve reference "${ref.full}": pull access denied, repository does not exist or may require authorization: server message: insufficient_scope: authorization failed`;
  }
  return `rpc error: code = NotFound desc = failed to pull and unpack image "${ref.full}": failed to resolve reference "${ref.full}": ${ref.full}: not found`;
}

/** Ports a container's program listens on once it reaches `serve`. */
export function listenPorts(info: ImageInfo | undefined, c: Container): number[] {
  if (!info) return [];
  const args = [...(c.command ?? []), ...(c.args ?? [])];
  if (info.ports) return info.ports(c.command ? args.slice(1) : (c.args ?? []));
  return info.defaultPort ? [info.defaultPort] : [];
}

// ---------- command interpretation ----------

export type StartResult = { ok: true; program: Program } | { ok: false; message: string };

export const SHELLS = new Set(["sh", "/bin/sh", "bash", "/bin/bash", "ash", "/bin/ash"]);

/** Binaries every shell image has (BusyBox or coreutils); exec.ts implements them. */
export const KNOWN_BINS = new Set([
  "echo", "cat", "ls", "touch", "rm", "mkdir", "test", "[", "true", "false", ":", "env", "printenv", "hostname", "date", "whoami", "id", "pwd",
  "sleep", "curl", "wget", "nslookup", "host", "dig", "head", "tail", "wc", "grep", "uname", "ps", "cp", "mv", "seq", "sh", "bash", "ash",
  "redis-cli", "nc", "df", "basename", "dirname", "printf", "kill", "exit",
]);
const SERVER_BINS = ["nginx", "httpd-foreground", "redis-server", "docker-entrypoint.sh", "postgres", "mysqld", "apache2-foreground", "/agnhost", "agnhost", "/server"];

/** Decides what a container runs, from its image and command/args. */
export function containerProgram(c: Container, info: ImageInfo, env: Record<string, string>, hostname: string): StartResult {
  if (!c.command || c.command.length === 0) {
    if (!c.args || c.args.length === 0 || !info.shell || info.repo.endsWith("/agnhost") || info.repo === "polinux/stress") return { ok: true, program: info.entrypoint({ env, args: c.args }) };
    // Images without an ENTRYPOINT treat args as the command.
    return runArgv(c.args, info, env, hostname);
  }
  return runArgv([...c.command, ...(c.args ?? [])], info, env, hostname);
}

function runArgv(argv: string[], info: ImageInfo, env: Record<string, string>, hostname: string): StartResult {
  const [bin, ...rest] = argv;
  if (SHELLS.has(bin)) {
    if (!info.shell) return notFound(bin);
    const i = rest.indexOf("-c");
    if (i >= 0) return { ok: true, program: compileScript(rest.slice(i + 1).join(" "), env, hostname) };
    return { ok: true, program: [{ op: "exit", code: 0 }] };
  }
  const base = bin.split("/").pop()!;
  // Infrastructure images (kube-proxy, provisioners, http-echo…) run their own binary.
  const self = info.repo.split("/").pop()!;
  if (!info.shell && (base === self || base.startsWith(self) || info.repo.startsWith("registry.k8s.io/"))) return { ok: true, program: info.entrypoint({ env, args: rest }) };
  if (SERVER_BINS.includes(bin) || SERVER_BINS.includes(base)) {
    if (info.repo.endsWith("/agnhost")) return { ok: true, program: info.entrypoint({ env, args: rest }) };
    if (info.http !== undefined || info.defaultPort) return { ok: true, program: info.entrypoint({ env }) };
  }
  if (base === "stress" && info.repo === "polinux/stress") return { ok: true, program: stressProgram(rest) };
  if (!info.shell) return notFound(bin);
  if (base === "perl") return { ok: true, program: perlProgram(rest) };
  if (!KNOWN_BINS.has(base)) return notFound(bin);
  return { ok: true, program: compileScript(argv.map(quoteWord).join(" "), env, hostname) };
}

const quoteWord = (w: string) => (/[\s;&|'"$<>]/.test(w) ? `'${w.replace(/'/g, `'\\''`)}'` : w);

function perlProgram(args: string[]): Program {
  const script = args.join(" ");
  const m = script.match(/bpi\((\d+)\)/);
  if (!m) return [{ op: "exit", code: 0 }];
  const n = Math.min(parseInt(m[1], 10), 5000);
  // bignum's bpi(2000) takes a few seconds of CPU.
  return [{ op: "burn", millicores: 1000 }, { op: "sleep", ms: 2000 + n * 2 }, { op: "burn", millicores: 0 }, { op: "log", text: piDigits(n) }, { op: "exit", code: 0 }];
}

function notFound(bin: string): StartResult {
  return {
    ok: false,
    message: `failed to create containerd task: failed to create shim task: OCI runtime create failed: runc create failed: unable to start container process: error during container init: exec: "${bin}": executable file not found in $PATH: unknown`,
  };
}

/** Splits a shell word list, honouring single and double quotes. */
export function shellWords(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q: string | null = null;
  let any = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === q) q = null;
      // Inside double quotes a backslash only escapes $, `, ", \ and newline (POSIX sh); elsewhere it stays.
      else if (ch === "\\" && q === '"' && i + 1 < s.length && '$`"\\\n'.includes(s[i + 1])) cur += s[++i];
      else cur += ch;
    } else if (ch === "'" || ch === '"') {
      q = ch;
      any = true;
    } else if (/\s/.test(ch)) {
      if (cur || any) out.push(cur);
      cur = "";
      any = false;
    } else if (ch === "\\" && i + 1 < s.length) {
      cur += s[++i];
    } else cur += ch;
  }
  if (cur || any) out.push(cur);
  return out;
}

export interface Statement {
  text: string;
  /** How this statement joins the previous one. */
  join: ";" | "&&" | "||";
}

/** Splits a script into statements on ; && || and newlines (outside quotes and $( )). */
export function splitStatements(script: string): Statement[] {
  const out: Statement[] = [];
  let cur = "";
  let q: string | null = null;
  let depth = 0;
  let join: Statement["join"] = ";";
  const push = (next: Statement["join"]) => {
    if (cur.trim()) out.push({ text: cur.trim(), join });
    cur = "";
    join = next;
  };
  for (let i = 0; i < script.length; i++) {
    const ch = script[i];
    if (q) {
      if (ch === q) q = null;
      cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      q = ch;
      cur += ch;
    } else if (ch === "$" && script[i + 1] === "(") {
      depth++;
      cur += "$(";
      i++;
    } else if (ch === ")" && depth > 0) {
      depth--;
      cur += ch;
    } else if (depth === 0 && (ch === ";" || ch === "\n")) {
      push(";");
    } else if (depth === 0 && ch === "&" && script[i + 1] === "&") {
      push("&&");
      i++;
    } else if (depth === 0 && ch === "|" && script[i + 1] === "|") {
      push("||");
      i++;
    } else cur += ch;
  }
  push(";");
  return out;
}

/** Splits `cmd > file` / `cmd >> file` into the command words and the redirect. */
export function parseRedirect(words: string[]): { argv: string[]; redirect?: { path: string; append: boolean } } {
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const m = w.match(/^(\d?)(>>?)(.*)$/);
    if (!m || m[1] === "2") continue;
    const append = m[2] === ">>";
    const path = m[3] || words[i + 1];
    if (!path) break;
    const argv = [...words.slice(0, i), ...words.slice(i + (m[3] ? 1 : 2))];
    if (path === "/dev/null") return { argv };
    return { argv, redirect: { path, append } };
  }
  return { argv: words };
}

/** Expands $VAR, ${VAR}, $(hostname) and $(date) the way sh would when the script starts. */
export function expandWord(word: string, env: Record<string, string>, hostname: string): string {
  return word
    .replace(/\$\(date\)/g, "\u0000DATE\u0000")
    .replace(/\$\(hostname\)/g, hostname)
    .replace(/\$\{?HOSTNAME\}?/g, hostname)
    .replace(/\$\{?(\w+)\}?/g, (_, n) => env[n] ?? "");
}

/** The placeholder a `for` variable expands to at compile time; the kubelet substitutes the current item. */
export const loopVar = (name: string) => `\u0001${name}\u0001`;
/** Most items a literal `for` list may have (a `$(seq a b)` range is counted, not expanded). */
const MAX_FOR_ITEMS = 10_000;

const LOOP_START = /^(while|until|for)\b/;

/** Index of the `done` that closes the loop opened at `stmts[i]`, or -1. */
function matchingDone(stmts: Statement[], i: number): number {
  let depth = 0;
  for (let j = i; j < stmts.length; j++) {
    const t = stmts[j].text.replace(/^do\s+/, "");
    if (LOOP_START.test(t)) depth++;
    if (/^done\b/.test(stmts[j].text)) {
      depth--;
      if (depth === 0) return j;
    }
  }
  return -1;
}

/** Compiles a shell script to a Program. Loops (while/until/for), &&, ||, redirects and $VARs are supported. */
export function compileScript(script: string, env: Record<string, string>, hostname: string): Program {
  const prog: Program = [];
  compileInto(prog, splitStatements(script), env, hostname);
  if (!prog.some((o) => o.op === "exit" || o.op === "serve" || o.op === "jump")) prog.push({ op: "exit", code: -1 });
  return prog;
}

function compileInto(prog: Program, stmts: Statement[], env: Record<string, string>, hostname: string): void {
  const emit = (st: Statement) => {
    let s = st.text;
    if (s.startsWith("do ")) s = s.slice(3).trim();
    if (s === "do" || !s) return;
    const words = shellWords(s).map((w) => expandWord(w, env, hostname));
    if (words.length === 0) return;
    const when = st.join === "&&" ? "ok" : st.join === "||" ? "fail" : undefined;
    const [bin, ...args] = words;
    if (bin === "sleep") {
      const a = args[0] ?? "0";
      if (a === "infinity" || a === "inf") prog.push({ op: "serve" });
      else prog.push({ op: "sleep", ms: parseDuration(a) });
      return;
    }
    if (bin === "exit") {
      prog.push({ op: "exit", code: parseInt(args[0] ?? "0", 10) || 0 });
      return;
    }
    if (bin === "tail" && args.includes("-f")) {
      prog.push({ op: "serve" });
      return;
    }
    if (bin === "exec" && args.length) {
      emit({ text: args.map(quoteWord).join(" "), join: st.join });
      return;
    }
    const { argv, redirect } = parseRedirect(words);
    prog.push({ op: "run", argv, ...(redirect ? { redirect } : {}), ...(when ? { when } : {}) });
  };

  for (let i = 0; i < stmts.length; i++) {
    const st = stmts[i];
    const s = st.text;
    const loop = LOOP_START.test(s) ? matchingDone(stmts, i) : -1;
    if (loop < 0) {
      if (/^done\b/.test(s)) continue; // a stray `done`
      emit(st);
      continue;
    }
    // The body: statements up to the matching `done`; `do` may share a line with the header.
    const w = s.match(/^(while|until)\s+(.+?)(?:\s*;?\s*do(?:\s+(.*))?)?$/);
    const f = s.match(/^for\s+(\w+)\s+in\s+(.+?)(?:\s*;?\s*do(?:\s+(.*))?)?$/);
    const inline = (w ? w[3] : f?.[3]) ?? "";
    const body = [...(inline ? [{ text: inline, join: ";" as const }] : []), ...stmts.slice(i + 1, loop)].map((b) => ({ ...b, text: b.text.replace(/^do(\s+|$)/, "") })).filter((b) => b.text);
    if (w) {
      const start = prog.length;
      const cond = w[2].trim();
      let jif = -1;
      if (!(w[1] === "while" && (cond === "true" || cond === ":"))) {
        emit({ text: cond, join: ";" });
        jif = prog.push({ op: "jumpif", when: w[1] === "while" ? "fail" : "ok", to: -1 }) - 1;
      }
      compileInto(prog, body, env, hostname);
      // Guard against tight loops with no sleep: make them tick at 1s.
      if (!prog.slice(start).some((o) => o.op === "sleep")) prog.push({ op: "sleep", ms: 1000 });
      prog.push({ op: "jump", to: start });
      if (jif >= 0) (prog[jif] as { to: number }).to = prog.length;
    } else if (f) {
      const list = f[2].trim();
      const sm = list.match(/^\$\(seq\s+(\d+)(?:\s+(\d+))?\)$/);
      const init = prog.push(
        sm
          ? { op: "forinit", var: f[1], from: sm[2] ? +sm[1] : 1, to: sm[2] ? +sm[2] : +sm[1], end: -1 }
          : { op: "forinit", var: f[1], items: shellWords(list).map((x) => expandWord(x, env, hostname)).slice(0, MAX_FOR_ITEMS), end: -1 },
      ) - 1;
      const bodyStart = prog.length;
      compileInto(prog, body, { ...env, [f[1]]: loopVar(f[1]) }, hostname);
      prog.push({ op: "fornext", var: f[1], init, to: bodyStart });
      (prog[init] as { end: number }).end = prog.length;
    }
    i = loop;
  }
}

export function parseDuration(s: string): number {
  const m = s.match(/^(\d+(?:\.\d+)?)([smhd]?)$/);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  const mult = { "": 1000, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "" | "s" | "m" | "h" | "d"];
  return n * mult;
}
