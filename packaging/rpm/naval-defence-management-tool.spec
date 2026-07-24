# Naval Defence Alliance Management Tool — vendored /opt RPM for openSUSE.
#
# Packages the electron-builder `dir` output (Electron runtime + app.asar +
# the PyInstaller sidecar in resources/python-sidecar/) as an opaque bundle,
# plus a %%{_bindir} wrapper, a .desktop entry and hicolor icons.
#
# Build with packaging/rpm/build-rpm.sh — it stages the sources and passes
# -D "appversion <package.json version>".

%global appname naval-defence
%global appdir  /opt/%{name}

# ---------------------------------------------------------------------------
# Prebuilt third-party binaries: no debuginfo, no stripping, no build-id links.
#
# NOTE: the Fedora-style %%__brp_strip / %%__brp_check_rpaths knobs do NOT
# exist on openSUSE — the whole brp chain hangs off %%__os_install_post, so
# that is what has to be silenced here. Stripping Electron or a PyInstaller
# one-file binary corrupts them; the build-id extraction fails on them too.
# ---------------------------------------------------------------------------
%global debug_package    %{nil}
%global __os_install_post %{nil}
%global _build_id_links  none

# The /opt tree is a self-contained vendor bundle. Never advertise its bundled
# sonames (libEGL.so, libGLESv2.so, libvulkan.so.1, libffmpeg.so ...) to the
# rest of the system, and never auto-generate Requires from it either — those
# would resolve against provides we just suppressed and make the package
# uninstallable. Runtime deps are declared explicitly below.
%global __provides_exclude_from ^%{appdir}/.*$
%global __requires_exclude_from ^%{appdir}/.*$

Name:           naval-defence-management-tool
Version:        %{?appversion}%{!?appversion:2.0.3}
Release:        0
Summary:        EVE Online alliance management tool (buyback, doctrines, market, industry)
License:        MIT
Group:          Productivity/Other
URL:            https://github.com/georgeatlumina/Eve_Corp_Buyback
Source0:        %{name}-%{version}-linux-x86_64.tar.gz
Source1:        naval-defence.sh
Source2:        naval-defence.desktop
Source3:        icon-128.png
Source4:        icon-512.png
Source5:        LICENSE
BuildArch:      x86_64

# Electron's own shared-library needs, expressed as sonames so this does not
# depend on openSUSE package naming. Everything else Chromium dlopen()s at
# runtime (libva, libpipewire, ...) is optional.
Requires:       libgtk-3.so.0()(64bit)
Requires:       libnss3.so()(64bit)
Requires:       libasound.so.2()(64bit)
Requires:       libX11.so.6()(64bit)
Requires:       libXtst.so.6()(64bit)
Requires:       libgbm.so.1()(64bit)
Requires:       libdrm.so.2()(64bit)
Requires:       libatk-1.0.so.0()(64bit)
Requires:       libatk-bridge-2.0.so.0()(64bit)
Requires:       libatspi.so.0()(64bit)
Requires:       libcups.so.2()(64bit)
Requires:       libpango-1.0.so.0()(64bit)
Requires:       libxkbcommon.so.0()(64bit)
Recommends:     xdg-utils

%description
Electron desktop app with a bundled Python (FastAPI) sidecar for managing an
EVE Online alliance: buyback pricing, doctrine stock, contracts, market data,
liquidation, SRP and industry build planning.

Chromium, Node and the Python runtime are bundled under /opt — this is a
vendored package and cannot be un-bundled.

%prep
%setup -q -n linux-unpacked
# %%license/%%doc copy out of the build dir, so put the file there.
cp -a %{SOURCE5} LICENSE

%build
# Nothing to build: Source0 is the finished electron-builder `dir` output.

%install
install -d %{buildroot}%{appdir}
cp -a . %{buildroot}%{appdir}/
rm -f %{buildroot}%{appdir}/LICENSE

# Chromium's SUID sandbox helper. Tumbleweed permits unprivileged user
# namespaces so Electron normally uses the namespace sandbox, but this is the
# fallback path, and shipping it non-setuid is exactly what produces
# "The SUID sandbox helper binary was found, but is not configured correctly".
# %%files lists the tree as a whole, so rpm records this mode verbatim —
# verify with: rpm -qplv <rpm> | grep chrome-sandbox   (expect -rwsr-xr-x)
chmod 4755 %{buildroot}%{appdir}/chrome-sandbox

install -Dm0755 %{SOURCE1} %{buildroot}%{_bindir}/%{appname}
install -Dm0644 %{SOURCE2} %{buildroot}%{_datadir}/applications/%{name}.desktop
install -Dm0644 %{SOURCE3} %{buildroot}%{_datadir}/icons/hicolor/128x128/apps/%{appname}.png
install -Dm0644 %{SOURCE4} %{buildroot}%{_datadir}/icons/hicolor/512x512/apps/%{appname}.png

%files
%defattr(-,root,root)
%license LICENSE
%{appdir}
%{_bindir}/%{appname}
%{_datadir}/applications/%{name}.desktop
%{_datadir}/icons/hicolor/128x128/apps/%{appname}.png
%{_datadir}/icons/hicolor/512x512/apps/%{appname}.png

%changelog
* Fri Jul 24 2026 Wolf <wolf.vdz@protonmail.com> - 2.0.3-0
- Initial local RPM package
