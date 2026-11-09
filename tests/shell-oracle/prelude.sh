# Loaded through BASH_ENV before `bash -c "<command>"` runs inside the oracle
# sandbox. It turns every program and builtin into a recorder, so bash parses
# and expands the command exactly as it would for real, but nothing runs.
#
# PATH points at an empty directory, so every external program reaches
# command_not_found_handle. Every builtin except `builtin` itself is shadowed
# by a function. Each call appends one record to $ORACLE_LOG: the recording
# process, where its fds 0-2 point, and its arguments, all NUL-separated. It
# then returns $ORACLE_STATUS, so a run can take either branch of `&&`/`||`.
# Keywords (`if`, `[[`, `time`, ...) cannot be shadowed and leave no record.

builtin unset BASH_ENV
__oracle_log=$ORACLE_LOG
__oracle_status=$ORACLE_STATUS
__oracle_coreutils=$ORACLE_COREUTILS

__oracle_fd() {
  "$__oracle_coreutils" --coreutils-prog=readlink "/proc/$1/fd/$2" 2>/dev/null
}

__oracle_record() {
  builtin local __me=$BASHPID __f0 __f1 __f2
  __f0=$(__oracle_fd "$__me" 0)
  __f1=$(__oracle_fd "$__me" 1)
  __f2=$(__oracle_fd "$__me" 2)
  builtin printf '%s\0' "@@REC" "$__me" "$__f0" "$__f1" "$__f2" "$#" "$@" >> "$__oracle_log"
  builtin return "$__oracle_status"
}

command_not_found_handle() {
  __oracle_record "$@"
}

__oracle_names=()
while builtin read -r _ __oracle_flag __oracle_name; do
  [[ -z $__oracle_name ]] && __oracle_name=$__oracle_flag
  [[ $__oracle_name == builtin ]] && continue
  __oracle_names+=("$__oracle_name")
done < <(builtin enable -a)
for __oracle_name in "${__oracle_names[@]}"; do
  builtin eval "function $__oracle_name { __oracle_record $(builtin printf '%q' "$__oracle_name") \"\$@\"; }" 2>/dev/null \
    || builtin printf 'oracle: cannot shadow builtin %s\n' "$__oracle_name" >&2
done
builtin unset __oracle_names __oracle_name __oracle_flag
