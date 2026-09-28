#!/usr/bin/env bash

hc_test_fail() {
  printf 'FAIL: %s\n' "$*" >&2
  return 1
}

hc_assert_equal() {
  local expected="$1"
  local actual="$2"
  local message="${3:-values differ}"

  if [[ "$expected" != "$actual" ]]; then
    hc_test_fail \
      "$message; expected=[$expected] actual=[$actual]"
  fi
}

hc_assert_contains() {
  local haystack="$1"
  local needle="$2"
  local message="${3:-text does not contain expected value}"

  if [[ "$haystack" != *"$needle"* ]]; then
    hc_test_fail "$message; missing=[$needle]"
  fi
}

hc_assert_not_contains() {
  local haystack="$1"
  local needle="$2"
  local message="${3:-text contains forbidden value}"

  if [[ "$haystack" == *"$needle"* ]]; then
    hc_test_fail "$message; forbidden=[$needle]"
  fi
}

hc_assert_file_absent() {
  local path="$1"
  local message="${2:-file should not exist}"

  if [[ -e "$path" ]]; then
    hc_test_fail "$message; path=[$path]"
  fi
}

hc_assert_file_exists() {
  local path="$1"
  local message="${2:-file should exist}"

  if [[ ! -f "$path" ]]; then
    hc_test_fail "$message; path=[$path]"
  fi
}
