# Shell behaviour reference

What the terminal's shell (`lib/kubectl/shell.ts`) copies from bash, and where that is written down.
The GNU Bash manual is at https://www.gnu.org/software/bash/manual/bash.html (fetched 2026-11-08);
the alias builtin's exact messages come from the bash source, https://git.savannah.gnu.org/cgit/bash.git/plain/builtins/alias.def.
The simulator's shell is not bash: it covers the parts below and says so when it meets something else
(command substitution, background jobs, functions, loops).

## Here-documents (`<<`, `<<-`)

- "This type of redirection instructs the shell to read input from the current source until it reads a line containing only delimiter (with no trailing blanks). All of the lines read up to that point then become the standard input" (3.6.6 Here Documents). The terminal shows a `> ` prompt until that line arrives, and a pasted block is fed in line by line.
- Quoted delimiter: "the delimiter is the result of quote removal on word, and the lines in the here-document are not expanded." So `<<'EOF'` and `<<"EOF"` copy the body as written.
- Unquoted: "the here-document text is treated similarly to a double-quoted string: all lines of the here-document are subjected to parameter expansion, command substitution, and arithmetic expansion". The simulator expands `$NAME` and `${NAME}`; inside a here-document `\$`, `` \` `` and `\\` are literal, and command substitution is reported as unsupported.
- `<<-`: "the shell strips leading tab characters are stripped from input lines and the line containing delimiter." Leading spaces are not stripped.
- Input that ends before the delimiter runs with bash's warning: ``bash: warning: here-document delimited by end-of-file (wanted `EOF')``.

## Files, `~` and `$HOME`

- Tilde expansion (3.5.2): "If this login name is the null string, the tilde is replaced with the value of the HOME shell variable." The simulator's home is `/home/candidate`; `~`, `~/x`, `$HOME/x` and `/home/candidate/x` all name the same file, which is stored as `x`. `ls ~` lists it, hiding dotfiles unless `-a`, as ls does.
- `cat > FILE` and `cat >> FILE` write the here-document or piped text to the virtual file (the Editor's files).

## Aliases (6.6 Aliases, and the alias builtin)

- "Aliases allow a string to be substituted for a word that is in a position in the input where it can be the first word of a simple command." Only the first word of a command (after `|`, `;`, `&&`, `||`) is checked, and only when it is not quoted.
- "The first word of the replacement text is tested for aliases, but a word that is identical to an alias being expanded is not expanded a second time."
- "If the last character of the alias value is a blank, then the shell checks the next command word following the alias for alias expansion."
- "Aliases are expanded when a command is read, not when it is executed. Therefore, an alias definition appearing on the same line as another command does not take effect until the shell reads the next line of input." Each line of a pasted block or a sourced file is read after the one before has run.
- `alias` with no arguments prints every alias "in a form that allows them to be reused as input", which in bash's source is `alias NAME='VALUE'` with an embedded `'` written `'\''`; `alias NAME` prints that one. Each argument without `=` is a request to print: an alias that does not exist gives `bash: alias: NAME: not found` (`sh_notfound`, "%s: not found"). The source treats an argument that starts with `=` the same way (`offset && name[offset] == '='` is false when the `=` is first), so the user's `alias ka ='kubectl -f apply'` is two arguments, `ka` and `=kubectl -f apply`, and prints `bash: alias: ka: not found` and `bash: alias: =kubectl -f apply: not found`, defining nothing. A name that has a `=` after other characters but is not a legal alias name gives `` bash: alias: `NAME': invalid alias name ``.
- `unalias [-a] name …`: "Remove each name from the list of aliases. If -a is supplied, remove all aliases. The return value is true unless a supplied name is not a defined alias." A missing name prints `bash: unalias: NAME: not found`.
- When a sourced file has the error, bash puts the file and line in front of it: `bash: /home/candidate/.bashrc: line 1: alias: ka: not found`. That prefix is from bash's behaviour at a real prompt, not from a passage in the manual that I found; treat it as the closest documented form.

## Variables and expansion

- `NAME=value` sets a shell variable; `export NAME[=value]` "Mark[s] each name to be passed to subsequently executed commands in the environment"; `unset NAME` "Remove[s] each variable or function name". `env` and `printenv` list the exported ones (HOME, USER, SHELL, PWD, TERM and PATH are there from the start). `NAME=value command` sets it for that command only.
- Parameter expansion (3.5.3): "The ‘$’ character introduces parameter expansion". `$NAME`, `${NAME}`, `${NAME:-default}`, `${#NAME}` and `$?` are supported; other `${…}` forms give `bad substitution`. A variable that has never been set expands to nothing; the manual's `-u` option, "Treat unset variables … as an error when performing parameter expansion", is off by default.
- Quoting: single quotes preserve "the literal value of each character within the quotes"; double quotes preserve every character "with the exception of ‘$’, ‘`’, ‘\’". So `'$x'` stays `$x` and `"$x"` expands.
- Word splitting (3.5.7): "The shell scans the results of parameter expansion … that did not occur within double quotes for word splitting. Words that were not expanded are not split." So an unquoted `$do` becomes the three arguments `--dry-run=client`, `-o`, `yaml`; `"$do"` stays one argument; an unquoted expansion of nothing disappears and `""` stays an empty argument.
- Assignment arguments to `export`/`alias`/`declare` are expanded without word splitting ("Assignment statements may also appear as arguments to the alias, declare, typeset, export, readonly, and local builtin commands").

## `source` and `.`

- ". [-p path] filename [arguments]: The . command reads and execute commands from the filename argument in the current shell context." `source` is "A synonym for .". The simulator runs each line in turn, so aliases and exports defined in the file are active afterwards. A file that does not exist gives `bash: NAME: No such file or directory`.

## Editors

- `nano`, `vi` and `vim` are not in bash; the simulator has one editor, the YAML editor tab. `nano [flags] FILE` (flags such as `-ET2 -l`, `-T 4`, `+LINE` are accepted and ignored) opens FILE there, creating it when it does not exist, and prints one line saying so. `kubectl edit` opens the tab as it always did; when `KUBE_EDITOR` or `EDITOR` is set its output says that tab is used instead of that editor.

## Session

- Aliases, variables and files live as long as one terminal session: they start empty on page load and after Start over. `k` stays a built-in alias for `kubectl`.

## What kubectl does with what the aliases produce

- `kubectl delete pod X --grace-period=0 --force` prints, as the real command does, `Warning: Immediate deletion does not wait for confirmation that the running resource has been terminated. The resource may continue to run on the cluster indefinitely.` (kubectl source, `pkg/cmd/delete/delete.go`: `o.WarningPrinter.Print("Immediate deletion does not wait for confirmation …")`, and the verb `force deleted`).
- `kubectl config set-context --current --namespace NAME` changes the namespace later commands use; `kubectl create deploy X --image=nginx --dry-run=client -o yaml` prints the Deployment without creating it; `kubectl run … $do > x.yaml` then `kubectl apply -f x.yaml` creates it.
