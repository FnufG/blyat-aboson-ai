#!/usr/bin/env bash
# Install a local, signature-verified Debian eSpeak NG for test speech only.
# No sudo, system package installation, Docker daemon or certificate changes.
set -euo pipefail
project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
install_dir="$project_dir/.local/espeak"
apt_dir="$install_dir/apt"
mkdir -p "$apt_dir/lists/partial" "$apt_dir/cache/archives/partial" "$apt_dir/log" "$apt_dir/empty-conf" "$install_dir/root" "$install_dir/bin"

if [[ ! -r /usr/share/keyrings/debian-archive-keyring.gpg ]] || [[ ! -x /usr/bin/apt-get ]]; then
  printf '%s\n' 'This installer requires Debian APT and the installed Debian archive keyring.' >&2
  exit 1
fi
if [[ "$(. /etc/os-release; printf '%s' "$ID")" != debian ]]; then
  printf '%s\n' 'This local installer supports Debian hosts only.' >&2
  exit 1
fi
suite="$(. /etc/os-release; printf '%s' "$VERSION_CODENAME")"
if [[ ! "$suite" =~ ^[a-z]+$ ]]; then
  printf '%s\n' 'Could not determine a supported Debian suite.' >&2
  exit 1
fi
printf 'deb [signed-by=/usr/share/keyrings/debian-archive-keyring.gpg] https://deb.debian.org/debian %s main\n' "$suite" > "$apt_dir/sources.list"
# APT recognizes lowercase proxy variables. Reuse platform proxy settings as-is.
# Never disable TLS, repository signatures, release validity or checksum checks.
export http_proxy="${http_proxy:-${HTTP_PROXY:-}}"
export https_proxy="${https_proxy:-${HTTPS_PROXY:-}}"
# Set these paths before APT loads any system hooks or cache cleanup rules.
: > "$apt_dir/empty.conf"
cat > "$apt_dir/apt.conf" <<APTCONF
Dir::Etc::parts "$apt_dir/empty-conf";
Dir::Etc::main "$apt_dir/empty.conf";
APTCONF
export APT_CONFIG="$apt_dir/apt.conf"
apt_options=(
  -o 'Debug::NoLocking=true'
  -o "Dir::Etc::sourcelist=$apt_dir/sources.list"
  -o "Dir::Etc::sourceparts=$apt_dir/empty-conf"
  -o "Dir::Etc::parts=$apt_dir/empty-conf"
  -o "Dir::State::lists=$apt_dir/lists"
  -o 'Dir::State::status=/var/lib/dpkg/status'
  -o "Dir::Cache=$apt_dir/cache"
  -o "Dir::Log=$apt_dir/log"
  -o 'APT::Get::List-Cleanup=0'
  -o 'Acquire::Languages=none'
  -o 'Acquire::https::CaInfo=/etc/ssl/certs/ca-certificates.crt'
  -o 'Acquire::Retries=2'
  -o "APT::Sandbox::User=$(id -un)"
)
/usr/bin/apt-get "${apt_options[@]}" update
/usr/bin/apt-get "${apt_options[@]}" --download-only --no-install-recommends -y install espeak-ng
shopt -s nullglob
packages=("$apt_dir/cache/archives/"*.deb)
if [[ ${#packages[@]} -eq 0 ]]; then
  printf '%s\n' 'No local packages downloaded. Use the system espeak-ng if it is already installed.' >&2
  exit 1
fi
for package in "${packages[@]}"; do
  /usr/bin/dpkg-deb --extract "$package" "$install_dir/root"
done
library_path="$(find "$install_dir/root/usr/lib" -name libespeak-ng.so.1 -printf '%h\n' -quit)"
if [[ -z "$library_path" ]]; then
  printf '%s\n' 'Downloaded packages did not contain the eSpeak NG shared library.' >&2
  exit 1
fi
library_relative="${library_path#"$install_dir/"}"
cat > "$install_dir/bin/espeak-ng" <<WRAPPER
#!/usr/bin/env bash
set -euo pipefail
espeak_local_dir="\$(cd -- "\$(dirname -- "\${BASH_SOURCE[0]}")/.." && pwd)"
export LD_LIBRARY_PATH="\$espeak_local_dir/$library_relative\${LD_LIBRARY_PATH:+:\$LD_LIBRARY_PATH}"
export ESPEAK_DATA_PATH="\$espeak_local_dir/$library_relative/espeak-ng-data"
exec "\$espeak_local_dir/root/usr/bin/espeak-ng" --path="\$espeak_local_dir/root/usr/lib/$(basename "$library_path")" "\$@"
WRAPPER
chmod +x "$install_dir/bin/espeak-ng"
"$install_dir/bin/espeak-ng" --version
"$install_dir/bin/espeak-ng" -v ru -w "$install_dir/test-ru.wav" 'Здравствуйте. Я тестовый консультант.'
printf 'Local executable: %s\n' "$install_dir/bin/espeak-ng"
