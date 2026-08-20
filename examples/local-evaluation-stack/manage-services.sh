#!/usr/bin/env bash
# Manage the complete local AgentDesk evaluation stack on macOS.
#
# Long-running Node processes are installed as per-user launchd agents, so
# closing the terminal does not stop them and an unexpected exit is restarted.
# Secrets remain in the existing env files; generated plists contain paths and
# executable arguments only.

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd -P)"
USER_UID="$(id -u)"
LAUNCH_DOMAIN="gui/${USER_UID}"
LAUNCH_AGENT_DIR="${AGENTDESK_LAUNCH_AGENT_DIR:-${HOME}/Library/LaunchAgents}"
LOG_DIR="${AGENTDESK_LOG_DIR:-${PROJECT_DIR}/data/runtime-logs}"
NODE_BIN="${AGENTDESK_NODE_BIN:-$(command -v node || true)}"
DOCKER_BIN="${AGENTDESK_DOCKER_BIN:-$(command -v docker || true)}"
START_OBSERVABILITY="${AGENTDESK_START_OBSERVABILITY:-1}"

HOST_LABEL="com.agentdesk.full-host"
BITABLE_LABEL="com.agentdesk.bitable-gateway"
ARCHIVE_LABEL="com.agentdesk.archive-gateway"

HOST_PLIST="${LAUNCH_AGENT_DIR}/${HOST_LABEL}.plist"
BITABLE_PLIST="${LAUNCH_AGENT_DIR}/${BITABLE_LABEL}.plist"
ARCHIVE_PLIST="${LAUNCH_AGENT_DIR}/${ARCHIVE_LABEL}.plist"

COMPOSE_PROJECT="agentdesk-observability-prod"
COMPOSE_FILE="${PROJECT_DIR}/infra/observability/docker-compose.prod.yml"

info() {
  printf '[agentdesk-services] %s\n' "$*"
}

warn() {
  printf '[agentdesk-services] WARN: %s\n' "$*" >&2
}

die() {
  printf '[agentdesk-services] ERROR: %s\n' "$*" >&2
  exit 1
}

require_file() {
  [[ -f "$1" ]] || die "Required file is missing: $1"
}

xml_escape() {
  printf '%s' "$1" | sed \
    -e 's/&/\&amp;/g' \
    -e 's/</\&lt;/g' \
    -e 's/>/\&gt;/g' \
    -e 's/"/\&quot;/g' \
    -e "s/'/\&apos;/g"
}

doctor() {
  [[ "$(uname -s)" == "Darwin" ]] || die 'This helper currently supports macOS launchd only.'
  [[ -n "${NODE_BIN}" && -x "${NODE_BIN}" ]] || die 'node was not found in PATH.'
  [[ -n "${DOCKER_BIN}" && -x "${DOCKER_BIN}" ]] || die 'docker was not found in PATH.'

  require_file "${PROJECT_DIR}/.env"
  require_file "${PROJECT_DIR}/examples/xiaohuan-doubao-audio/.env"
  require_file "${PROJECT_DIR}/examples/xiaohuan-bitable-bridge/.env"
  require_file "${PROJECT_DIR}/examples/bitable-pilot/start-gateway.mjs"
  require_file "${PROJECT_DIR}/examples/vision-archive-pilot/start-gateway.mjs"
  require_file "${PROJECT_DIR}/examples/voice-photos-feishu-monitor/launcher.ts"
  require_file "${COMPOSE_FILE}"
  require_file "${PROJECT_DIR}/node_modules/tsx/package.json"

  local node_major
  node_major="$(${NODE_BIN} -p 'Number(process.versions.node.split(".")[0])')"
  (( node_major >= 20 )) || die "Node.js 20+ is required; found $(${NODE_BIN} --version)."

  info "Project: ${PROJECT_DIR}"
  info "Node: ${NODE_BIN} ($(${NODE_BIN} --version))"
  info "Docker CLI: ${DOCKER_BIN}"
  info "LaunchAgents: ${LAUNCH_AGENT_DIR}"
  info "Logs: ${LOG_DIR}"

  if "${DOCKER_BIN}" info >/dev/null 2>&1; then
    info 'Docker daemon: ready'
  else
    warn 'Docker daemon is not ready; start/install will try to open Docker Desktop.'
  fi
}

ensure_docker() {
  if "${DOCKER_BIN}" info >/dev/null 2>&1; then
    return
  fi

  info 'Docker daemon is unavailable; opening Docker Desktop...'
  /usr/bin/open -gja Docker || die 'Could not open Docker Desktop.'

  local attempt
  for attempt in $(seq 1 120); do
    if "${DOCKER_BIN}" info >/dev/null 2>&1; then
      info 'Docker daemon is ready.'
      return
    fi
    sleep 1
  done
  die 'Docker daemon did not become ready within 120 seconds.'
}

write_plist() {
  local target="$1"
  local label="$2"
  local stdout_path="$3"
  local stderr_path="$4"
  shift 4

  local tmp_file
  tmp_file="$(mktemp "${TMPDIR:-/tmp}/agentdesk-launchd.XXXXXX")"
  local service_path
  service_path="$(dirname "${NODE_BIN}"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

  {
    printf '%s\n' '<?xml version="1.0" encoding="UTF-8"?>'
    printf '%s\n' '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">'
    printf '%s\n' '<plist version="1.0"><dict>'
    printf '  <key>Label</key><string>%s</string>\n' "$(xml_escape "${label}")"
    printf '%s\n' '  <key>ProgramArguments</key><array>'
    local argument
    for argument in "$@"; do
      printf '    <string>%s</string>\n' "$(xml_escape "${argument}")"
    done
    printf '%s\n' '  </array>'
    printf '  <key>WorkingDirectory</key><string>%s</string>\n' "$(xml_escape "${PROJECT_DIR}")"
    printf '%s\n' '  <key>EnvironmentVariables</key><dict>'
    printf '    <key>PATH</key><string>%s</string>\n' "$(xml_escape "${service_path}")"
    printf '%s\n' '  </dict>'
    printf '%s\n' '  <key>RunAtLoad</key><true/>'
    printf '%s\n' '  <key>KeepAlive</key><true/>'
    printf '%s\n' '  <key>ThrottleInterval</key><integer>5</integer>'
    printf '%s\n' '  <key>ExitTimeOut</key><integer>30</integer>'
    printf '%s\n' '  <key>ProcessType</key><string>Background</string>'
    printf '%s\n' '  <key>Umask</key><integer>63</integer>'
    printf '  <key>StandardOutPath</key><string>%s</string>\n' "$(xml_escape "${stdout_path}")"
    printf '  <key>StandardErrorPath</key><string>%s</string>\n' "$(xml_escape "${stderr_path}")"
    printf '%s\n' '</dict></plist>'
  } >"${tmp_file}"

  /usr/bin/plutil -lint "${tmp_file}" >/dev/null
  /usr/bin/install -m 600 "${tmp_file}" "${target}"
  /bin/rm -f "${tmp_file}"
}

render_plists() {
  /bin/mkdir -p "${LAUNCH_AGENT_DIR}" "${LOG_DIR}"
  /bin/chmod 700 "${LOG_DIR}"

  write_plist \
    "${BITABLE_PLIST}" \
    "${BITABLE_LABEL}" \
    "${LOG_DIR}/bitable.out.log" \
    "${LOG_DIR}/bitable.err.log" \
    "${NODE_BIN}" \
    "${PROJECT_DIR}/examples/bitable-pilot/start-gateway.mjs"

  write_plist \
    "${ARCHIVE_PLIST}" \
    "${ARCHIVE_LABEL}" \
    "${LOG_DIR}/archive.out.log" \
    "${LOG_DIR}/archive.err.log" \
    "${NODE_BIN}" \
    "${PROJECT_DIR}/examples/vision-archive-pilot/start-gateway.mjs"

  write_plist \
    "${HOST_PLIST}" \
    "${HOST_LABEL}" \
    "${LOG_DIR}/host.out.log" \
    "${LOG_DIR}/host.err.log" \
    "${NODE_BIN}" \
    "--env-file=${PROJECT_DIR}/.env" \
    "--env-file=${PROJECT_DIR}/examples/xiaohuan-doubao-audio/.env" \
    "--env-file=${PROJECT_DIR}/examples/xiaohuan-bitable-bridge/.env" \
    '--import' \
    'tsx' \
    '--input-type=module' \
    '--eval' \
    'await import("./examples/xiaohuan-bitable-bridge/index.ts"); await import("./examples/voice-photos-feishu-monitor/launcher.ts")'

  info "Rendered launchd agents in ${LAUNCH_AGENT_DIR}"
}

job_loaded() {
  /bin/launchctl print "${LAUNCH_DOMAIN}/$1" >/dev/null 2>&1
}

job_uses_plist() {
  local label="$1"
  local plist="$2"
  /bin/launchctl print "${LAUNCH_DOMAIN}/${label}" 2>/dev/null | /usr/bin/grep -Fq "path = ${plist}"
}

bootout_job() {
  local label="$1"
  if job_loaded "${label}"; then
    /bin/launchctl bootout "${LAUNCH_DOMAIN}/${label}" >/dev/null 2>&1 || true
    local attempt
    for attempt in $(seq 1 100); do
      if ! job_loaded "${label}"; then
        return
      fi
      sleep 0.1
    done
    die "launchd did not finish unloading ${label} within 10 seconds."
  fi
}

bootstrap_job() {
  local label="$1"
  local plist="$2"

  /bin/launchctl enable "${LAUNCH_DOMAIN}/${label}" >/dev/null 2>&1 || true

  if job_loaded "${label}" && ! job_uses_plist "${label}" "${plist}"; then
    info "Replacing non-persistent job ${label} with ${plist}"
    bootout_job "${label}"
  fi

  if ! job_loaded "${label}"; then
    /bin/launchctl bootstrap "${LAUNCH_DOMAIN}" "${plist}"
  fi
  /bin/launchctl kickstart "${LAUNCH_DOMAIN}/${label}" >/dev/null
}

wait_for_http_ok() {
  local name="$1"
  local url="$2"
  local attempt
  for attempt in $(seq 1 90); do
    if /usr/bin/curl --max-time 3 -fsS -o /dev/null "${url}" 2>/dev/null; then
      info "Ready: ${name} (${url})"
      return
    fi
    sleep 1
  done
  die "${name} did not become healthy within 90 seconds: ${url}"
}

wait_for_http_listener() {
  local name="$1"
  local url="$2"
  local attempt code
  for attempt in $(seq 1 60); do
    code="$(/usr/bin/curl --max-time 3 -sS -o /dev/null -w '%{http_code}' -X POST \
      -H 'content-type: application/json' -d '{}' "${url}" 2>/dev/null || true)"
    if [[ -n "${code}" && "${code}" != '000' ]]; then
      info "Listening: ${name} (${url}, HTTP ${code})"
      return
    fi
    sleep 1
  done
  die "${name} did not start listening within 60 seconds: ${url}"
}

configured_path() {
  local key="$1"
  "${NODE_BIN}" \
    "--env-file=${PROJECT_DIR}/.env" \
    "--env-file=${PROJECT_DIR}/examples/xiaohuan-doubao-audio/.env" \
    "--env-file=${PROJECT_DIR}/examples/xiaohuan-bitable-bridge/.env" \
    -e 'process.stdout.write(process.env[process.argv[1]]?.trim() ?? "")' \
    "${key}"
}

wait_for_readable_directory() {
  local name="$1"
  local path="$2"
  local attempt
  [[ -n "${path}" ]] || die "${name} path is not configured."
  for attempt in $(seq 1 30); do
    if [[ -d "${path}" && -r "${path}" ]]; then
      info "Ready: ${name} (${path})"
      return
    fi
    sleep 1
  done
  die "${name} is unavailable or unreadable: ${path}"
}

start_observability() {
  [[ "${START_OBSERVABILITY}" == '1' ]] || return
  info 'Starting the observability stack...'
  "${DOCKER_BIN}" compose -p "${COMPOSE_PROJECT}" -f "${COMPOSE_FILE}" up -d
}

stop_observability() {
  [[ "${START_OBSERVABILITY}" == '1' ]] || return
  if "${DOCKER_BIN}" info >/dev/null 2>&1; then
    info 'Stopping the observability stack (volumes are preserved)...'
    "${DOCKER_BIN}" compose -p "${COMPOSE_PROJECT}" -f "${COMPOSE_FILE}" stop
  else
    warn 'Docker is unavailable; observability containers could not be stopped.'
  fi
}

verify_services() {
  local voice_photos_root archive_root
  voice_photos_root="$(configured_path VOICE_PHOTOS_ROOT)"
  archive_root="$(configured_path VISION_ARCHIVE_ROOT)"

  wait_for_http_listener 'Bitable Gateway' 'http://127.0.0.1:8088/describe'
  wait_for_http_listener 'Archive Gateway' 'http://127.0.0.1:8090/describe'
  wait_for_http_ok 'Host' 'http://127.0.0.1:3200/readyz'
  wait_for_http_ok 'Voice Bridge' 'http://127.0.0.1:50020/healthz'
  wait_for_http_ok 'Web' 'http://127.0.0.1:3100/login'
  wait_for_http_listener 'Gateway signing proxy' 'http://127.0.0.1:8799/describe'
  wait_for_readable_directory 'Voice photo/JSON root' "${voice_photos_root}"
  wait_for_readable_directory 'Vision Archive root' "${archive_root}"

  if [[ "${START_OBSERVABILITY}" == '1' ]]; then
    wait_for_http_ok 'Grafana' 'http://127.0.0.1:3001/api/health'
    wait_for_http_ok 'Prometheus' 'http://127.0.0.1:9091/-/ready'
    wait_for_http_ok 'Alertmanager' 'http://127.0.0.1:9093/-/ready'
    wait_for_http_ok 'Phoenix' 'http://127.0.0.1:6006/healthz'
  fi
}

start_services() {
  local force_reload="${1:-0}"
  doctor
  ensure_docker
  render_plists
  start_observability

  if [[ "${force_reload}" == '1' ]]; then
    bootout_job "${HOST_LABEL}"
    bootout_job "${ARCHIVE_LABEL}"
    bootout_job "${BITABLE_LABEL}"
  fi

  bootstrap_job "${BITABLE_LABEL}" "${BITABLE_PLIST}"
  wait_for_http_listener 'Bitable Gateway' 'http://127.0.0.1:8088/describe'
  bootstrap_job "${ARCHIVE_LABEL}" "${ARCHIVE_PLIST}"
  wait_for_http_listener 'Archive Gateway' 'http://127.0.0.1:8090/describe'
  bootstrap_job "${HOST_LABEL}" "${HOST_PLIST}"
  verify_services

  info 'All managed services are running under launchd KeepAlive.'
  info 'Web: http://127.0.0.1:3100/login'
  info "Logs: ${LOG_DIR}"
}

stop_services() {
  info 'Stopping managed launchd services...'
  /bin/launchctl disable "${LAUNCH_DOMAIN}/${HOST_LABEL}" >/dev/null 2>&1 || true
  /bin/launchctl disable "${LAUNCH_DOMAIN}/${ARCHIVE_LABEL}" >/dev/null 2>&1 || true
  /bin/launchctl disable "${LAUNCH_DOMAIN}/${BITABLE_LABEL}" >/dev/null 2>&1 || true
  bootout_job "${HOST_LABEL}"
  bootout_job "${ARCHIVE_LABEL}"
  bootout_job "${BITABLE_LABEL}"
  stop_observability
  info 'Managed services stopped.'
}

job_status() {
  local label="$1"
  if ! job_loaded "${label}"; then
    printf '%-38s %s\n' "${label}" 'not loaded'
    return 1
  fi

  local details state pid runs
  details="$(/bin/launchctl print "${LAUNCH_DOMAIN}/${label}")"
  state="$(printf '%s\n' "${details}" | awk '/^[[:space:]]*state = / { print $3; exit }')"
  pid="$(printf '%s\n' "${details}" | awk '/^[[:space:]]*pid = / { print $3; exit }')"
  runs="$(printf '%s\n' "${details}" | awk '/^[[:space:]]*runs = / { print $3; exit }')"
  printf '%-38s state=%-8s pid=%-7s runs=%s\n' "${label}" "${state:-unknown}" "${pid:--}" "${runs:--}"
  [[ "${state}" == 'running' ]]
}

probe_status() {
  local name="$1"
  local url="$2"
  if /usr/bin/curl --max-time 10 -fsS -o /dev/null "${url}"; then
    printf '  [OK]   %-18s %s\n' "${name}" "${url}"
    return 0
  fi
  printf '  [FAIL] %-18s %s\n' "${name}" "${url}"
  return 1
}

probe_listener_status() {
  local name="$1"
  local url="$2"
  local code
  code="$(/usr/bin/curl --max-time 3 -sS -o /dev/null -w '%{http_code}' -X POST \
    -H 'content-type: application/json' -d '{}' "${url}" 2>/dev/null || true)"
  if [[ -n "${code}" && "${code}" != '000' ]]; then
    printf '  [OK]   %-18s %s (HTTP %s)\n' "${name}" "${url}" "${code}"
    return 0
  fi
  printf '  [FAIL] %-18s %s\n' "${name}" "${url}"
  return 1
}

probe_directory_status() {
  local name="$1"
  local path="$2"
  if [[ -n "${path}" && -d "${path}" && -r "${path}" ]]; then
    printf '  [OK]   %-18s %s\n' "${name}" "${path}"
    return 0
  fi
  printf '  [FAIL] %-18s %s\n' "${name}" "${path:-not configured}"
  return 1
}

status_services() {
  local failed=0
  local voice_photos_root archive_root
  voice_photos_root="$(configured_path VOICE_PHOTOS_ROOT)"
  archive_root="$(configured_path VISION_ARCHIVE_ROOT)"
  info 'launchd jobs:'
  job_status "${BITABLE_LABEL}" || failed=1
  job_status "${ARCHIVE_LABEL}" || failed=1
  job_status "${HOST_LABEL}" || failed=1

  info 'health endpoints:'
  probe_listener_status 'Bitable Gateway' 'http://127.0.0.1:8088/describe' || failed=1
  probe_listener_status 'Archive Gateway' 'http://127.0.0.1:8090/describe' || failed=1
  probe_status 'Host' 'http://127.0.0.1:3200/readyz' || failed=1
  probe_status 'Voice Bridge' 'http://127.0.0.1:50020/healthz' || failed=1
  probe_status 'Web' 'http://127.0.0.1:3100/login' || failed=1
  probe_listener_status 'Signing proxy' 'http://127.0.0.1:8799/describe' || failed=1
  probe_directory_status 'Photo/JSON root' "${voice_photos_root}" || failed=1
  probe_directory_status 'Archive root' "${archive_root}" || failed=1

  if [[ "${START_OBSERVABILITY}" == '1' ]]; then
    probe_status 'Grafana' 'http://127.0.0.1:3001/api/health' || failed=1
    probe_status 'Prometheus' 'http://127.0.0.1:9091/-/ready' || failed=1
    probe_status 'Alertmanager' 'http://127.0.0.1:9093/-/ready' || failed=1
    probe_status 'Phoenix' 'http://127.0.0.1:6006/healthz' || failed=1
  fi

  if [[ "${failed}" == '0' ]]; then
    info 'Status: healthy'
  else
    warn 'Status: one or more checks failed'
  fi
  return "${failed}"
}

show_logs() {
  local service="${1:-all}"
  case "${service}" in
    host)
      exec /usr/bin/tail -n 200 -F "${LOG_DIR}/host.out.log" "${LOG_DIR}/host.err.log"
      ;;
    bitable)
      exec /usr/bin/tail -n 200 -F "${LOG_DIR}/bitable.out.log" "${LOG_DIR}/bitable.err.log"
      ;;
    archive)
      exec /usr/bin/tail -n 200 -F "${LOG_DIR}/archive.out.log" "${LOG_DIR}/archive.err.log"
      ;;
    observability)
      exec "${DOCKER_BIN}" compose -p "${COMPOSE_PROJECT}" -f "${COMPOSE_FILE}" logs -f
      ;;
    all)
      exec /usr/bin/tail -n 100 -F \
        "${LOG_DIR}/host.out.log" "${LOG_DIR}/host.err.log" \
        "${LOG_DIR}/bitable.out.log" "${LOG_DIR}/bitable.err.log" \
        "${LOG_DIR}/archive.out.log" "${LOG_DIR}/archive.err.log"
      ;;
    *)
      die 'logs service must be one of: all, host, bitable, archive, observability'
      ;;
  esac
}

uninstall_services() {
  stop_services
  /bin/rm -f "${HOST_PLIST}" "${BITABLE_PLIST}" "${ARCHIVE_PLIST}"
  info 'Removed the three generated LaunchAgent plists. Runtime logs and Docker volumes were preserved.'
}

usage() {
  cat <<'USAGE'
Usage: examples/local-evaluation-stack/manage-services.sh <command>

Commands:
  install               Generate LaunchAgents, replace old transient jobs, and start everything
  start                 Start all services; keeps an already-running service uninterrupted
  restart               Gracefully reload all managed services and verify health
  stop                  Stop and disable managed services; preserves data, logs, and Docker volumes
  status                Show launchd state and health probes
  logs [service]        Follow logs: all | host | bitable | archive | observability
  doctor                Validate local prerequisites without changing runtime state
  render                Generate/validate plists without loading them
  uninstall             Stop services and remove the three generated LaunchAgent plists

Environment overrides:
  AGENTDESK_START_OBSERVABILITY=0   Do not manage the Docker observability stack
  AGENTDESK_LAUNCH_AGENT_DIR=...    Alternate plist directory (useful for validation)
  AGENTDESK_LOG_DIR=...             Alternate persistent log directory
  AGENTDESK_NODE_BIN=...            Explicit Node.js binary
  AGENTDESK_DOCKER_BIN=...          Explicit Docker CLI binary
USAGE
}

command="${1:-help}"
case "${command}" in
  install)
    start_services 1
    ;;
  start)
    start_services 0
    ;;
  restart)
    start_services 1
    ;;
  stop)
    stop_services
    ;;
  status)
    status_services
    ;;
  logs)
    show_logs "${2:-all}"
    ;;
  doctor)
    doctor
    ;;
  render)
    doctor
    render_plists
    ;;
  uninstall)
    uninstall_services
    ;;
  help|-h|--help)
    usage
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac
