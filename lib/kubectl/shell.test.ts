import { describe, expect, test } from "bun:test";
import { Cluster } from "@/lib/engine";
import { SimStore } from "@/lib/sim/useSimulation";
import { runKubectl, type KubectlContext } from "./kubectl";
import { HOME, needsMore, newShell, splitScript } from "./shell";

/** A fresh terminal session: no aliases, no variables beyond the usual environment, no files. */
function session() {
  const files: Record<string, string> = {};
  const ctx: KubectlContext & { files: Record<string, string> } = { cluster: new Cluster({ seed: 1, systemPods: true }), namespace: "default", files, shell: newShell() };
  const sh = (line: string) => runKubectl(ctx, line);
  return { ctx, sh, out: (line: string) => sh(line).out };
}

/** What the user pastes to set up the exam terminal, typos and all. */
const BASHRC = `alias ka ='kubectl -f apply'
alias kc='kubectl create'
alias kd='kubectl describe'
alias kg='kubectl get'
alias kn='kubectl config set-context --current --namespace'
alias krm='kubectl delete'
alias nano='nano -ET2 -l'

export do="--dry-run=client -o yaml"
export now="--grace-period=0 --force"
export KUBE_EDITOR="nano -ET2 -l"`;
const PASTE = `cat >> ~/.bashrc <<'EOF'\n${BASHRC}\nEOF`;

describe("here-documents", () => {
  test("<<'EOF' and <<\"EOF\" copy the body as written; <<EOF expands variables", () => {
    const { sh, out } = session();
    sh("name=world");
    expect(out("cat <<'EOF'\nhello $name ${name}\nEOF")).toBe("hello $name ${name}");
    expect(out('cat <<"EOF"\nhello $name\nEOF')).toBe("hello $name");
    expect(out("cat <<EOF\nhello $name and ${name} and \\$name\nEOF")).toBe("hello world and world and $name");
    expect(out("cat <<EOF\nunset: [$nothing]\nEOF")).toBe("unset: []");
  });
  test("<<-EOF strips leading tabs from the body and the delimiter line, <<EOF does not", () => {
    const { out } = session();
    expect(out("cat <<-EOF\n\t\tindented\n\tx\n\tEOF")).toBe("indented\nx");
    expect(out("cat <<EOF\n\tkept\nEOF")).toBe("\tkept");
  });
  test("a heredoc feeds cat > FILE and cat >> FILE, and the editor files include ~/.bashrc", () => {
    const { ctx, sh, out } = session();
    sh("cat > ~/a.txt <<EOF\none\nEOF");
    sh("cat >> $HOME/a.txt <<EOF\ntwo\nEOF");
    expect(ctx.files["a.txt"]).toBe("one\ntwo\n");
    expect(out("cat ~/a.txt")).toBe("one\ntwo");
    expect(out("cat /home/candidate/a.txt")).toBe("one\ntwo");
    sh("cat > .bashrc <<EOF\nx\nEOF");
    expect(out("cat ~/.bashrc")).toBe("x");
    expect(out("ls ~")).toBe("a.txt");
    expect(out("ls -a")).toBe(".bashrc  a.txt");
    expect(out("pwd")).toBe(HOME);
  });
  test("a command carries on after its here-document", () => {
    const { out } = session();
    expect(out("cat <<EOF | grep -c b\na\nb\nb2\nEOF")).toBe("2");
    expect(out("cat <<EOF && echo after\nbody\nEOF")).toBe("body\nafter");
  });
  test("input is incomplete until the delimiter, an open quote or a trailing operator is finished", () => {
    expect(needsMore("cat <<EOF")).toBe(true);
    expect(needsMore("cat <<EOF\nbody")).toBe(true);
    expect(needsMore("cat <<EOF\nbody\nEOF")).toBe(false);
    expect(needsMore("cat <<-'EOF'\n\tbody\n\tEOF")).toBe(false);
    expect(needsMore("echo 'one")).toBe(true);
    expect(needsMore("echo 'one\ntwo'")).toBe(false);
    expect(needsMore('echo "one')).toBe(true);
    expect(needsMore("echo a |")).toBe(true);
    expect(needsMore("echo a && ")).toBe(true);
    expect(needsMore("echo a \\")).toBe(true);
    expect(needsMore("echo it's # a comment with ' in it".replace("it's", "its"))).toBe(false);
    expect(needsMore("echo plain")).toBe(false);
  });
  test("a heredoc cut short by the end of input runs with bash's warning", () => {
    const { sh } = session();
    const r = sh("cat <<EOF\nhalf");
    expect(r.out).toBe("half\nbash: warning: here-document delimited by end-of-file (wanted `EOF')");
  });
  test("two heredocs on one line take their bodies in order", () => {
    expect(splitScript("cat <<A <<B\na\nA\nb\nB").pieces[0].docs.map((d) => [d.delim, d.body])).toEqual([["A", "a\n"], ["B", "b\n"]]);
  });
});

describe("aliases", () => {
  test("define, list in bash's format, show one, and remove", () => {
    const { sh, out } = session();
    expect(out("alias")).toBe("");
    sh("alias kg='kubectl get'");
    sh("alias zz=\"echo it's\"");
    expect(out("alias")).toBe("alias kg='kubectl get'\nalias zz='echo it'\\''s'");
    expect(out("alias kg")).toBe("alias kg='kubectl get'");
    expect(sh("alias nope")).toEqual({ out: "bash: alias: nope: not found", ok: false });
    expect(out("unalias kg; alias")).toBe("alias zz='echo it'\\''s'");
    expect(sh("unalias kg")).toEqual({ out: "bash: unalias: kg: not found", ok: false });
    sh("unalias -a");
    expect(out("alias")).toBe("");
  });
  test("only the first word of a command is expanded, and not when quoted", () => {
    const { sh, out } = session();
    sh("alias e='echo [x]'");
    expect(out("e e")).toBe("[x] e");
    expect(out("echo e")).toBe("e");
    expect(out("'e' hi").includes("command not found")).toBe(true);
    expect(out("true && e ok")).toBe("[x] ok");
    expect(out("echo a | e")).toBe("[x]");
  });
  test("an alias ending in a blank lets the next word be an alias too, and an alias is not expanded inside itself", () => {
    const { sh, out } = session();
    sh("alias a='echo '");
    sh("alias b='B'");
    expect(out("a b")).toBe("B");
    expect(out("echo b")).toBe("b");
    sh("alias ls='ls -a'");
    sh("alias loop='loop2'");
    sh("alias loop2='loop'");
    expect(out("loop").includes("command not found")).toBe(true);
  });
  test("an alias defined on a line does not affect the rest of that line", () => {
    const { sh } = session();
    expect(sh("alias q='echo hi'; q").out).toBe("bash: q: command not found\nTry \"help\" for what this terminal can do.");
    expect(sh("q").out).toBe("hi");
  });
  test("alias ka ='kubectl -f apply' fails the way bash does: two 'not found' errors, nothing defined", () => {
    const { sh, out } = session();
    const r = sh("alias ka ='kubectl -f apply'");
    expect(r).toEqual({ out: "bash: alias: ka: not found\nbash: alias: =kubectl -f apply: not found", ok: false });
    expect(out("alias")).toBe("");
    expect(sh("alias bad/name=x").out).toBe("bash: alias: `bad/name': invalid alias name");
  });
});

describe("variables", () => {
  test("NAME=value, export, unset, env and printenv", () => {
    const { sh, out } = session();
    sh("A=1");
    sh("export B=2");
    expect(out("echo $A $B")).toBe("1 2");
    expect(out("env | grep -E '^(A|B)='")).toBe("B=2");
    expect(out("printenv B")).toBe("2");
    expect(sh("printenv A").ok).toBe(false);
    sh("export A");
    expect(out("printenv A")).toBe("1");
    sh("unset A");
    expect(out("echo [$A]")).toBe("[]");
    expect(sh("export 1x=2").out).toBe("bash: export: `1x=2': not a valid identifier");
    expect(out("FOO=bar printenv FOO")).toBe("bar");
    expect(out("echo [$FOO]")).toBe("[]");
  });
  test("$NAME and ${NAME} expand unquoted and in double quotes, never in single quotes; unset names are empty", () => {
    const { sh, out } = session();
    sh("x=hello");
    expect(out("echo $x ${x}world \"$x\" '$x' \"${x}!\" $nothing end")).toBe("hello helloworld hello $x hello! end");
    expect(out("echo ${nothing:-fallback} ${x:-no} ${#x}")).toBe("fallback hello 5");
    expect(out("echo \\$x")).toBe("$x");
    expect(out("echo ~ ~/a")).toBe(`${HOME} ${HOME}/a`);
    expect(out("echo $HOME $USER")).toBe(`${HOME} candidate`);
  });
  test("an unquoted expansion splits into words; a quoted one stays whole; an empty one disappears", () => {
    const { sh, out } = session();
    sh('export flags="--dry-run=client -o yaml"');
    expect(out("echo $flags | wc -w")).toBe("3");
    expect(out('echo "$flags" | wc -w')).toBe("3");
    expect(out("echo a$flags").includes("a--dry-run=client")).toBe(true);
    sh("empty=''");
    expect(out("echo a $empty b")).toBe("a b");
    expect(out('echo a "$empty" b')).toBe("a  b");
    expect(out("kubectl run x --image=nginx $flags")).toContain("kind: Pod");
  });
  test("$? is the status of the last command", () => {
    const { out } = session();
    expect(out("false; echo $?")).toBe("1");
    expect(out("true; echo $?")).toBe("0");
  });
});

describe("source", () => {
  test("source and . run each line of a file in the current shell, so its aliases and exports stick", () => {
    const { sh, out } = session();
    sh("cat > rc <<EOF\nalias hi='echo hello'\nexport V=7\nEOF");
    expect(out("hi")).toContain("command not found");
    sh("source rc");
    expect(out("hi there")).toBe("hello there");
    expect(out("echo $V")).toBe("7");
    sh("unalias hi");
    sh(". rc");
    expect(out("hi")).toBe("hello");
  });
  test("a line of the file is read after the one before it ran, so it can use an alias defined above", () => {
    const { sh, out } = session();
    sh("cat > rc <<EOF\nalias say='echo said'\nsay one\nEOF");
    expect(out("source rc")).toBe("said one");
  });
  test("errors in a sourced file name the file and the line, like bash", () => {
    const { sh } = session();
    sh("cat > rc <<EOF\ntrue\nalias nope\nEOF");
    expect(sh("source rc").out).toBe("bash: /home/candidate/rc: line 2: alias: nope: not found");
    expect(sh("source missing")).toEqual({ out: "bash: missing: No such file or directory", ok: false });
  });
});

describe("editors", () => {
  test("nano and vi open the file in the editor tab, accept and ignore flags, and print nothing, like the real tools", () => {
    const { ctx, sh } = session();
    const r = sh("nano -ET2 -l x.yaml");
    expect(r).toEqual({ out: "", ok: true, openFile: "x.yaml", editor: "nano" });
    expect(ctx.files["x.yaml"]).toBeUndefined();
    expect(sh("nano -T 4 ~/y.yaml").openFile).toBe("y.yaml");
    expect(sh("vim +3 z.yaml")).toEqual({ out: "", ok: true, openFile: "z.yaml", editor: "vi" });
    expect(sh("vi -- w.yaml")).toMatchObject({ openFile: "w.yaml", editor: "vi" });
    ctx.files["keep.yaml"] = "a: b\n";
    sh("nano keep.yaml");
    expect(ctx.files["keep.yaml"]).toBe("a: b\n");
  });
  test("kubectl edit says the editor tab is used even when KUBE_EDITOR is set", () => {
    const { sh } = session();
    sh("kubectl create deployment web --image=nginx");
    sh('export KUBE_EDITOR="nano -ET2 -l"');
    expect(sh("kubectl edit deployment web").out).toBe("Opened deployment-web.yaml in the YAML editor tab, not in nano -ET2 -l (the simulator has no real editor). Change it, then press Apply.");
  });
});

describe("what the aliases produce still works in kubectl", () => {
  test("--grace-period=0 --force prints kubectl's warning, and the Pod is gone", () => {
    const { ctx, sh } = session();
    sh("kubectl run x --image=nginx");
    sh('export now="--grace-period=0 --force"');
    const r = sh("kubectl delete pod x $now");
    expect(r.out).toBe('Warning: Immediate deletion does not wait for confirmation that the running resource has been terminated. The resource may continue to run on the cluster indefinitely.\npod "x" force deleted from default namespace');
    ctx.cluster.advance(1000);
    expect(sh("kubectl get pod x").ok).toBe(false);
  });
  test("config set-context --current --namespace changes the namespace later commands use", () => {
    const { sh, out } = session();
    sh("kubectl create namespace dev");
    sh("alias kn='kubectl config set-context --current --namespace'");
    sh("alias kc='kubectl create'");
    expect(out("kn dev")).toContain("modified");
    sh("kc deploy web --image=nginx");
    expect(out("kubectl get deploy -n dev")).toContain("web");
    expect(out("kubectl get deploy -n default")).not.toContain("web");
  });
  test("create deploy … $do prints YAML without creating it; run … $do > x.yaml then a fixed ka applies it", () => {
    const { sh, out } = session();
    sh('export do="--dry-run=client -o yaml"');
    expect(out("kubectl create deploy x --image=nginx $do")).toContain("kind: Deployment");
    expect(sh("kubectl get deploy x").ok).toBe(false);
    sh("kubectl run p --image=nginx $do > x.yaml");
    expect(out("cat x.yaml")).toContain("kind: Pod");
    sh("alias ka='kubectl apply -f'");
    expect(out("ka x.yaml")).toBe("pod/p created");
    expect(out("ka ~/x.yaml")).toBe("pod/p unchanged");
  });
  test("the user's alias ka='kubectl -f apply' (flag before the verb) is kubectl's own error", () => {
    const { sh } = session();
    sh("alias ka='kubectl -f apply'");
    const r = sh("ka x.yaml");
    expect(r.ok).toBe(false);
    expect(r.out.length).toBeGreaterThan(0);
  });
});

describe("the exam terminal setup, pasted as the user pastes it", () => {
  test("nothing works before the setup", () => {
    const { sh, out } = session();
    for (const c of ["ka x.yaml", "kc deploy x --image=nginx", "kd pod x", "kg pods", "kn dev", "krm pod x"]) expect(sh(c).out, c).toContain("command not found");
    expect(out("echo [$do] [$now] [$KUBE_EDITOR]")).toBe("[] [] []");
    expect(out("alias")).toBe("");
    expect(sh("cat ~/.bashrc").out).toBe("cat: /home/candidate/.bashrc: No such file or directory");
    expect(out("k get pods")).toContain("No resources found");
  });
  test("the paste writes ~/.bashrc and defines nothing yet", () => {
    const { ctx, sh, out } = session();
    expect(needsMore(PASTE)).toBe(false);
    expect(sh(PASTE)).toEqual({ out: "", ok: true });
    expect(ctx.files[".bashrc"]).toBe(BASHRC + "\n");
    expect(out("cat ~/.bashrc")).toBe(BASHRC);
    expect(out("alias")).toBe("");
    expect(sh("kg pods").out).toContain("command not found");
  });
  test("source ~/.bashrc reports the two typo errors, then every other alias and variable works", () => {
    const { sh, out } = session();
    sh(PASTE);
    const r = sh("source ~/.bashrc");
    expect(r.out).toBe("bash: /home/candidate/.bashrc: line 1: alias: ka: not found\nbash: /home/candidate/.bashrc: line 1: alias: =kubectl -f apply: not found");
    expect(out("alias")).toBe(["alias kc='kubectl create'", "alias kd='kubectl describe'", "alias kg='kubectl get'", "alias kn='kubectl config set-context --current --namespace'", "alias krm='kubectl delete'", "alias nano='nano -ET2 -l'"].join("\n"));
    expect(out("ka x.yaml")).toContain("command not found");
    expect(out("echo $do | wc -w")).toBe("3");
    expect(out("echo $now")).toBe("--grace-period=0 --force");
    expect(out("printenv KUBE_EDITOR")).toBe("nano -ET2 -l");
    expect(out("kg pods")).toContain("No resources found");
    expect(out("kc deploy web --image=nginx")).toBe("deployment.apps/web created");
    expect(out("kd deploy web")).toContain("Name:                   web");
    expect(out("kc deploy dry --image=nginx $do")).toContain("kind: Deployment");
    expect(out("kn kube-public")).toContain("modified");
    expect(out("kg pods")).toContain("kube-public namespace");
    expect(sh("nano x.yaml").openFile).toBe("x.yaml");
    expect(sh("nano -ET2 -l x.yaml")).toMatchObject({ openFile: "x.yaml", editor: "nano" });
    expect(sh("kg pod p").ok).toBe(false);
    sh("kubectl run p --image=nginx");
    expect(out("krm pod p $now")).toContain("force deleted");
  });
  test("pasted a line at a time, as a terminal does, the block runs once its delimiter arrives", () => {
    const { sh } = session();
    let pending: string[] = [];
    const runs: string[] = [];
    for (const line of PASTE.split("\n")) {
      pending = [...pending, line];
      if (needsMore(pending.join("\n"))) continue;
      runs.push(pending.join("\n"));
      sh(pending.join("\n"));
      pending = [];
    }
    expect(runs).toHaveLength(1);
    expect(pending).toEqual([]);
  });
  test("aliases, variables and files belong to the session: Start over empties them", () => {
    const s = new SimStore();
    s.cluster = new Cluster({ seed: 1, systemPods: true });
    s.exec(PASTE);
    s.exec("source ~/.bashrc");
    expect(s.exec("kg pods")?.out).toContain("No resources found");
    s.reset();
    expect(s.exec("kg pods")?.out).toContain("command not found");
    expect(s.exec("echo [$do]")?.out).toBe("[]");
    expect(s.exec("cat ~/.bashrc")?.out).toContain("No such file or directory");
  });
  test("help lists the new builtins", () => {
    const { out } = session();
    const help = out("help");
    for (const w of ["alias", "unalias", "export", "unset", "env", "printenv", "source", "nano", "<< EOF"]) expect(help, w).toContain(w);
  });
});

describe("scripts: source depth, the usual ~/.bashrc lines, functions", () => {
  test("a file that sources itself, or two that source each other, stop with bash's message", () => {
    const { ctx, sh } = session();
    ctx.files["a.sh"] = "echo hello\nsource a.sh";
    const self = sh("source a.sh");
    expect(self.out).toContain("bash: a.sh: maximum source depth exceeded");
    expect(self.out.match(/hello/g)?.length).toBe(100);
    ctx.files["m.sh"] = "source n.sh";
    ctx.files["n.sh"] = "source m.sh";
    expect(sh("source m.sh").out).toContain("maximum source depth exceeded");
    // The depth is released afterwards: a plain source still works.
    ctx.files["ok.sh"] = "echo fine";
    expect(sh("source ok.sh").out).toBe("fine");
  });
  test("a pasted exam ~/.bashrc runs without 'command not found'", () => {
    const { ctx, sh, out } = session();
    ctx.files[".bashrc"] = ["alias k=kubectl", "complete -o default -F __start_kubectl k", "export do=\"--dry-run=client -o yaml\"", "export now=\"--force --grace-period 0\"", "set -o vi", "shopt -s expand_aliases", "trap '' INT"].join("\n");
    const r = sh("source ~/.bashrc");
    expect(r.out).toBe("");
    expect(r.ok).toBe(true);
    expect(out("alias")).toBe("alias k='kubectl'");
    expect(out("echo $do")).toBe("--dry-run=client -o yaml");
    for (const c of ["complete -p", "set +H", "shopt -s histappend", "trap - INT"]) expect(sh(c), c).toEqual({ out: "", ok: true });
  });
  test("process substitution gets a clear message, not 'command not found'", () => {
    const { sh } = session();
    for (const c of ["source <(kubectl completion bash)", "diff <(echo a) <(echo b)"]) {
      const r = sh(c);
      expect(r.ok, c).toBe(false);
      expect(r.out, c).toContain("process substitution");
      expect(r.out, c).not.toContain("command not found");
    }
    // The same line inside a sourced file.
    const { ctx, sh: sh2 } = session();
    ctx.files[".bashrc"] = "alias k=kubectl\nsource <(kubectl completion bash)\nexport do=x";
    const r = sh2("source ~/.bashrc");
    expect(r.out).toContain("process substitution");
    expect(r.out).not.toContain("command not found");
    expect(sh2("echo $do").out).toBe("x");
    // A here-string is not process substitution.
    expect(sh2("cat <<< hi").out).toBe("hi");
  });
  test("function definitions are refused and their body never runs", () => {
    const { sh } = session();
    for (const def of ["f() { echo BODY; }", "f () { echo BODY; }", "function f { echo BODY; }", "function f() { echo BODY; }", "f() {\n  echo BODY\n}"]) {
      const r = sh(def);
      expect(r.ok, def).toBe(false);
      expect(r.out, def).toContain("shell functions are not supported in the simulator");
      expect(r.out, def).not.toContain("BODY");
      expect(r.out, def).not.toContain("command not found");
    }
    expect(sh("f").out).toContain("command not found");
    expect(sh("echo hi")).toEqual({ out: "hi", ok: true });
  });
  test("vi and vim consume the value of -c and friends, and +N; nano consumes its own; nothing is created on open", () => {
    const { ctx, sh } = session();
    expect(sh("vi -c 'set ts=2' f.yaml")).toMatchObject({ openFile: "f.yaml", editor: "vi" });
    expect(sh("vim +3 g.yaml").openFile).toBe("g.yaml");
    expect(sh("vim -u NONE -c 'set nu' +5 h.yaml").openFile).toBe("h.yaml");
    expect(sh("vi --cmd 'set nu' k.yaml").openFile).toBe("k.yaml");
    expect(sh("nano -T 4 n.yaml").openFile).toBe("n.yaml");
    expect(Object.keys(ctx.files)).toEqual([]);
  });
});
