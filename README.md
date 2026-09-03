# TheRock Build Topology Explorer

A framework-free, static visualization of TheRock's `BUILD_TOPOLOGY.toml`.
On page load it fetches the current topology from TheRock's `main` branch. The
left pane is an interactive DAG; the right pane shows the selected entity's
metadata and direct relationships.

To inspect a historical topology, enter its Git commit SHA in **Topology commit
SHA** and select **Load**. The explorer accepts 7–64 hexadecimal characters,
loads `BUILD_TOPOLOGY.toml` at that exact commit, and records the selection in
the page URL as `?sha=<commit>` so it can be shared or bookmarked. Leave the
field empty to return to the latest `main` topology.

## Run locally

The explorer has no application server or build-time framework dependency. It
can be deployed as this directory to GitHub Pages. On each load, it retrieves
the current topology from `raw.githubusercontent.com`, which allows
cross-origin browser requests. An internet connection is required.

You can open `index.html` directly in a browser. A local static server is also
useful when testing:

```bash
python3 -m http.server 8000
```

Then open <http://localhost:8000>.

To use GitHub Pages without a deployment workflow, place the files in the
repository's `docs/` directory. A GitHub Actions Pages deployment can publish
this directory directly without moving it.

## Test

Run the topology contract tests with:

```bash
npm test
```

The tests download the latest `BUILD_TOPOLOGY.toml` from TheRock's `main`
branch, parse it with both the browser parser and Python's standard-library
`tomllib`, then compare the generated graph with a Python oracle matching
TheRock's current `build_topology.py` schema and defaults. Network access is
therefore required when running the suite.

## CMake feature preview

Paste one or more `-DTHEROCK_ENABLE_*=ON|OFF` flags into the feature panel to
see the artifact components that the topology selects. Use the platform toggle
to compare fresh Linux and Windows x86_64 configurations. The preview applies
TheRock's current feature-group defaults, explicit artifact feature flags, and
the implicit artifact dependency closure performed by
`therock_finalize_features()`. Components unavailable on the selected platform
are omitted from the graph.

It intentionally does not interpret other CMake flags, an existing CMake cache,
toolchain detection, or project-specific configuration outside the artifact
topology.

## Graph relationships

The graph's left-to-right flow is upstream to downstream:

- **Source requirement:** source set → build stage
- **Group dependency:** prerequisite artifact group → dependent group
- **Group membership:** artifact group → artifact
- **Artifact dependency:** prerequisite artifact → dependent artifact
- **Build stage membership:** build stage → artifact group

Source requirements are derived from the union of source sets declared by a
stage's artifact groups. Build stages are the CI/sharding owners of their
artifact groups, not a declaration of execution order. The graph can be panned
with the mouse and zoomed with the scroll wheel.
