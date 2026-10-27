#!/bin/sh
# PostgreSQL archive_command: archive one WAL file without ever overwriting.
#
#   archive_command = '/opt/cursus/archive-wal.sh %p %f'
#   archive-wal.sh <source path> <file name> [archive directory, default /backup/wal]
#
# PostgreSQL may ask to archive a file that is already archived: after a crash
# between the copy and its own bookkeeping, or (on a standby with
# archive_mode=always) for a segment an operator placed in the archive so the
# standby could restore it. A bare `test ! -f` then fails for ever and the
# archiver stops advancing. So:
#   - destination absent: copy to a temporary name, flush it, link it into
#     place (link never replaces an existing file), flush the directory;
#   - destination present and byte-identical: success, without touching it;
#   - destination present and different: refuse. Two different files under
#     one WAL name is an integrity fault for an operator, never overwritten.
set -eu

if [ "$#" -lt 2 ] || [ "$#" -gt 3 ]; then
    echo "usage: archive-wal.sh <source path> <file name> [archive directory]" >&2
    exit 2
fi
src=$1 name=$2 dir=${3:-/backup/wal}
case $name in
    '' | .* | */*) echo "archive-wal: invalid WAL file name '$name'" >&2; exit 2 ;;
esac
[ -f "$src" ] || { echo "archive-wal: source $src is not a file" >&2; exit 1; }
dest=$dir/$name

flush() {  # fsync one file or directory; fall back to a full sync
    sync "$1" 2>/dev/null || sync
}

if [ -e "$dest" ]; then
    if cmp -s "$src" "$dest"; then
        echo "archive-wal: $name is already archived with identical contents; not rewriting it" >&2
        exit 0
    fi
    echo "archive-wal: $name is already archived with DIFFERENT contents; refusing (operator review required)" >&2
    exit 1
fi

tmp=$dir/.archive-wal.$name.$$
trap 'rm -f "$tmp"' EXIT HUP INT TERM
cp "$src" "$tmp"
flush "$tmp"
if ! ln "$tmp" "$dest" 2>/dev/null; then
    # Someone else archived it in the meantime: accept only identical bytes.
    if [ -e "$dest" ] && cmp -s "$src" "$dest"; then
        exit 0
    fi
    echo "archive-wal: could not link $name into $dir" >&2
    exit 1
fi
flush "$dir"
