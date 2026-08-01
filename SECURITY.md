# Security policy

Mizu is not ready for production use. Until signed builds, an owned update
service, sandbox regression tests, and a documented disclosure channel exist,
all builds should be treated as development builds.

Firefox security releases must be evaluated immediately. Use
`./mizu upstream-check`, review Mozilla's advisories, update the pinned commit,
rebuild both modes, and exercise the browser smoke tests before distributing a
new Mizu build.

Do not report Firefox vulnerabilities publicly in this repository. Follow
Mozilla's security bug process for upstream issues. Once this project has a
maintainer-controlled private reporting address, add it here before publishing
binary releases.

