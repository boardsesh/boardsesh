package main

import (
	"encoding/json"
	"os"
	"reflect"
	"strings"
	"testing"
)

type policyFragment struct {
	TagOwners map[string][]string `json:"tagOwners"`
	Grants    []policyGrant       `json:"grants"`
	Tests     []policyTest        `json:"tests"`
}

type policyGrant struct {
	Sources      []string `json:"src"`
	Destinations []string `json:"dst"`
	IP           []string `json:"ip"`
}

type policyTest struct {
	Source string   `json:"src"`
	Proto  string   `json:"proto"`
	Accept []string `json:"accept"`
	Deny   []string `json:"deny"`
}

func TestTailnetPolicyFragmentIsNarrow(t *testing.T) {
	contents, err := os.ReadFile("tailnet-policy.fragment.json")
	if err != nil {
		t.Fatalf("read policy fragment: %v", err)
	}
	var fragment policyFragment
	if err := json.Unmarshal(contents, &fragment); err != nil {
		t.Fatalf("parse policy fragment: %v", err)
	}

	wantOwners := map[string][]string{
		"tag:boardsesh-db-forwarder": {"autogroup:admin"},
		"tag:boardsesh-db-ci":        {"autogroup:admin"},
		"tag:boardsesh-dr":           {"autogroup:admin"},
	}
	if !reflect.DeepEqual(fragment.TagOwners, wantOwners) {
		t.Fatalf("tag owners = %#v", fragment.TagOwners)
	}
	if len(fragment.Grants) != 3 || len(fragment.Tests) != 2 {
		t.Fatalf("fragment has %d grants and %d tests", len(fragment.Grants), len(fragment.Tests))
	}

	for _, grant := range fragment.Grants {
		for _, selector := range append(append(append([]string{}, grant.Sources...), grant.Destinations...), grant.IP...) {
			if selector == "*" || strings.Contains(selector, ":*") {
				t.Fatalf("broad selector %q is forbidden", selector)
			}
		}
		if !reflect.DeepEqual(grant.Destinations, []string{forwarderTag}) {
			t.Fatalf("grant destination = %#v", grant.Destinations)
		}
	}

	ciGrant := fragment.Grants[0]
	if !reflect.DeepEqual(ciGrant.Sources, []string{"tag:boardsesh-db-ci"}) || !reflect.DeepEqual(ciGrant.IP, []string{"tcp:5432", "tcp:5433"}) {
		t.Fatalf("CI grant widened: %#v", ciGrant)
	}
	drGrant := fragment.Grants[1]
	if !reflect.DeepEqual(drGrant.Sources, []string{"tag:boardsesh-dr"}) || !reflect.DeepEqual(drGrant.IP, []string{"tcp:5432"}) {
		t.Fatalf("DR grant widened: %#v", drGrant)
	}
}
