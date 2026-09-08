#!/usr/bin/env bash
set -Eeuo pipefail

tmux_binary="${1:?pass the host tmux executable}"
socket_directory="${2:?pass the host socket directory}"

# create private socket storage without replacing existing mounts
# keep the caller's file permissions for agent processes
(umask 077; mkdir -p -- "$socket_directory")
# select only the configured host socket, never an inherited pane
unset TMUX TMUX_PANE
# reuse live servers or recover stale sockets through tmux's startup lock
exec "$tmux_binary" -S "$socket_directory/default" start-server \; set-option -s exit-empty off
