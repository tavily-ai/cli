#!/bin/sh
set -e

PACKAGE_NAME="@tavily/cli"
COMMAND_NAME="tvly"
MIN_NODE_MAJOR=20
MIN_NODE_MINOR=1
MANAGERS="npm pnpm yarn bun"
FRESH_INSTALL=0
INIT_COMPLETED=0

# Colors (only when outputting to a terminal)
if [ -t 1 ]; then
    RED='\033[0;31m'
    GREEN='\033[0;32m'
    YELLOW='\033[0;33m'
    BLUE='\033[0;34m'
    BOLD='\033[1m'
    RESET='\033[0m'
else
    RED='' GREEN='' YELLOW='' BLUE='' BOLD='' RESET=''
fi

info()  { printf "${BLUE}${BOLD}==>${RESET} %s\n" "$1"; }
warn()  { printf "${YELLOW}${BOLD}warning:${RESET} %s\n" "$1"; }
error() { printf "${RED}${BOLD}error:${RESET} %s\n" "$1" >&2; exit 1; }

# Require Node.js >= 20.1
require_node() {
    version=""
    if command -v node >/dev/null 2>&1; then
        version=$(node -p "process.versions.node" 2>/dev/null) || version=""
    fi
    major=$(echo "$version" | cut -d. -f1)
    minor=$(echo "$version" | cut -d. -f2)
    case "$major$minor" in
        ''|*[!0-9]*) major=0 minor=0 ;;
    esac
    if [ "$major" -gt "$MIN_NODE_MAJOR" ] || \
       { [ "$major" -eq "$MIN_NODE_MAJOR" ] && [ "$minor" -ge "$MIN_NODE_MINOR" ]; }; then
        return 0
    fi
    error "Node.js ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}+ is required but not found.
  Install it from https://nodejs.org/en/download and try again."
}

# The manager's list of global packages
list_global_packages() {
    case "$1" in
        npm)  npm ls -g --depth=0 "$PACKAGE_NAME" 2>/dev/null ;;
        pnpm) pnpm ls -g "$PACKAGE_NAME" 2>/dev/null ;;
        yarn) yarn global list 2>/dev/null ;;
        bun)  bun pm ls -g 2>/dev/null ;;
    esac
}

# Succeeds when the given manager reports ${PACKAGE_NAME} among its global packages
manager_owns_package() {
    list_global_packages "$1" | grep -Eq "(^|[^A-Za-z0-9_./-])${PACKAGE_NAME}(@|[[:space:]]|$)"
}

# The ${PACKAGE_NAME} version the given manager has installed, or nothing
installed_package_version() {
    list_global_packages "$1" \
        | grep -Eo "(^|[^A-Za-z0-9_./-])${PACKAGE_NAME}[@ ][0-9][0-9A-Za-z.+-]*" \
        | head -n 1 | sed "s#.*${PACKAGE_NAME}[@ ]##"
}

# Run the manager's global install; pass "${PACKAGE_NAME}@latest" to upgrade
run_manager_install() {
    case "$1" in
        npm)  npm install -g "$2" ;;
        pnpm) pnpm add -g "$2" ;;
        yarn) yarn global add "$2" ;;
        bun)  bun add -g "$2" ;;
    esac
}

can_run_init_interactively() {
    [ -z "${CI:-}" ] || return 1
    [ -z "${SSH_CONNECTION:-}" ] || return 1
    [ -z "${SSH_TTY:-}" ] || return 1
    [ -t 1 ] || return 1

    # Browser OAuth cannot complete reliably in a display-less Linux session.
    if [ "$(uname -s 2>/dev/null || true)" = "Linux" ] && \
       [ -z "${DISPLAY:-}" ] && [ -z "${WAYLAND_DISPLAY:-}" ]; then
        return 1
    fi

    # `curl ... | sh` uses stdin for the script, but an interactive terminal
    # remains available through /dev/tty.
    [ -t 0 ] || ( : </dev/tty ) 2>/dev/null
}

run_init_handoff() {
    [ "$FRESH_INSTALL" = "1" ] || return 0

    if ! command -v "$COMMAND_NAME" >/dev/null 2>&1; then
        return 0
    fi

    if ! can_run_init_interactively; then
        return 0
    fi

    if ! "$COMMAND_NAME" init --help >/dev/null 2>&1; then
        warn "The installed CLI does not provide 'tvly init'. Run 'tvly update', then 'tvly init'."
        return 0
    fi

    info "Starting guided Tavily setup..."
    if [ -t 0 ]; then
        if "$COMMAND_NAME" init; then
            INIT_COMPLETED=1
            return 0
        fi
    elif "$COMMAND_NAME" init </dev/tty; then
        INIT_COMPLETED=1
        return 0
    fi

    warn "Guided setup did not complete. The CLI is installed; run 'tvly init' to try again."
}

main() {
    printf "\n${BOLD}Tavily CLI Installer${RESET}\n\n"

    require_node

    # Preserve the package manager that already owns Tavily CLI. Otherwise use
    # the first available one for a fresh installation.
    owner=""
    first_available=""
    for manager in $MANAGERS; do
        command -v "$manager" >/dev/null 2>&1 || continue
        [ -n "$first_available" ] || first_available=$manager
        if manager_owns_package "$manager"; then
            owner=$manager
            break
        fi
    done

    if [ -n "$owner" ]; then
        info "Upgrading ${PACKAGE_NAME} with ${owner}..."
        installer=$owner
        run_manager_install "$owner" "${PACKAGE_NAME}@latest"
    elif [ -n "$first_available" ]; then
        info "Installing ${PACKAGE_NAME} with ${first_available}..."
        FRESH_INSTALL=1
        installer=$first_available
        run_manager_install "$first_available" "$PACKAGE_NAME"
    else
        error "npm, pnpm, yarn, or bun is required to install ${PACKAGE_NAME}.
  Install Node.js from https://nodejs.org/en/download and try again."
    fi

    # Verify
    if command -v "$COMMAND_NAME" >/dev/null 2>&1; then
        installed_version=$("$COMMAND_NAME" --version 2>/dev/null || echo "unknown")
        printf "\n${GREEN}${BOLD}Success!${RESET} ${installed_version} is installed.\n"
        # An older tvly (the Python CLI) earlier on PATH would keep running instead of this one.
        expected_version=$(installed_package_version "$installer" || true)
        if [ -n "$expected_version" ] && [ "${installed_version##* }" != "$expected_version" ]; then
            warn "'${COMMAND_NAME} --version' reports ${installed_version##* }, but ${PACKAGE_NAME} ${expected_version} was just installed.
  An older ${COMMAND_NAME} earlier on PATH ($(command -v "$COMMAND_NAME")) is shadowing the npm install.
  Remove it with 'uv tool uninstall tavily-cli' or 'pipx uninstall tavily-cli', then restart your shell."
        fi
    else
        printf "\n${GREEN}${BOLD}Installed!${RESET} You may need to restart your shell or add the install directory to your PATH.\n"
    fi

    run_init_handoff

    printf "\nNext steps:\n"
    if [ "$INIT_COMPLETED" != "1" ]; then
        printf "  ${BOLD}${COMMAND_NAME} init${RESET}        # guided authentication and skill setup\n"
    fi
    printf "  ${BOLD}${COMMAND_NAME} search${RESET} ...  # search the web\n\n"
}

main
