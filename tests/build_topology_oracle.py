#!/usr/bin/env python3
"""JSON oracle matching the current TheRock build_topology.py schema."""

import json
import sys
import tomllib


def defaults(values, **default_values):
    return {**default_values, **values}


def graph(topology, source_file):
    nodes = []
    edges = []

    def add_node(node_id, kind, name, fields):
        nodes.append({
            "id": node_id,
            "kind": kind,
            "name": name,
            "description": fields.get("description", ""),
            "fields": fields,
        })

    for name, values in topology.get("source_sets", {}).items():
        fields = defaults(values, description="", submodules=[],
                          external_git_sources=[], disable_platforms=[],
                          path_prefixes=[])
        add_node(f"source:{name}", "source-set", name, fields)

    for name, values in topology.get("artifact_groups", {}).items():
        fields = defaults(values, description="", type="generic",
                          artifact_group_deps=[], source_sets=[])
        add_node(f"group:{name}", "artifact-group", name, fields)
        for dependency in fields["artifact_group_deps"]:
            edges.append({"source": f"group:{dependency}",
                          "target": f"group:{name}",
                          "kind": "group-dependency"})

    for name, values in topology.get("artifacts", {}).items():
        fields = defaults(
            values, description="", type="target-neutral", artifact_deps=[],
            platform=None, feature_name=None, feature_group=None,
            disable_platforms=[], disable_platforms_if_flags_not_set={},
            disable_processors=[], python_requires=[], split_databases=[],
            test_artifacts=[], source_paths=[name],
        )
        if not fields["source_paths"]:
            fields["source_paths"] = [name]
        fields["effective_feature_name"] = (
            fields["feature_name"] or name.upper().replace("-", "_")
        )
        fields["effective_feature_group"] = (
            fields["feature_group"]
            or fields["artifact_group"].upper().replace("-", "_")
        )
        add_node(f"artifact:{name}", "artifact", name, fields)
        edges.append({"source": f"group:{fields['artifact_group']}",
                      "target": f"artifact:{name}",
                      "kind": "group-membership"})
        for dependency in fields["artifact_deps"]:
            edges.append({"source": f"artifact:{dependency}",
                          "target": f"artifact:{name}",
                          "kind": "artifact-dependency"})

    groups = topology.get("artifact_groups", {})
    for name, values in topology.get("build_stages", {}).items():
        fields = defaults(values, description="", artifact_groups=[],
                          type="generic")
        add_node(f"stage:{name}", "build-stage", name, fields)
        source_sets = []
        for group_name in fields["artifact_groups"]:
            for source_set in groups.get(group_name, {}).get("source_sets", []):
                if source_set not in source_sets:
                    source_sets.append(source_set)
        for source_set in source_sets:
            edges.append({"source": f"source:{source_set}",
                          "target": f"stage:{name}",
                          "kind": "source-requirement"})
        for group_name in fields["artifact_groups"]:
            edges.append({"source": f"stage:{name}",
                          "target": f"group:{group_name}",
                          "kind": "stage-membership"})

    return {"metadata": {**topology.get("metadata", {}),
                         "source_file": source_file},
            "nodes": nodes, "edges": edges}


if sys.argv[1] == "-":
    parsed = tomllib.loads(sys.stdin.read())
else:
    with open(sys.argv[1], "rb") as topology_file:
        parsed = tomllib.load(topology_file)
print(json.dumps({"parsed": parsed, "graph": graph(parsed, sys.argv[2])}))
