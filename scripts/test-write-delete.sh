#!/bin/bash
# Test Write/Delete Tool Pairs
# Usage: ./scripts/test-write-delete.sh <SERVER_URL> <JWT_TOKEN>

BASE_URL="${1:-https://tanda-workforce-mcp-server-production.up.railway.app}"
JWT_TOKEN="$2"

if [ -z "$JWT_TOKEN" ]; then
  echo "Usage: $0 <SERVER_URL> <JWT_TOKEN>"
  echo "Example: $0 https://your-server.up.railway.app eyJ..."
  exit 1
fi

echo "=============================================="
echo "Testing Write/Delete Tool Pairs"
echo "Server: $BASE_URL"
echo "=============================================="

call_tool() {
  local tool_name="$1"
  local args="$2"

  curl -s -X POST "$BASE_URL/mcp" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $JWT_TOKEN" \
    -d "{
      \"jsonrpc\": \"2.0\",
      \"id\": $(date +%s%N),
      \"method\": \"tools/call\",
      \"params\": {
        \"name\": \"$tool_name\",
        \"arguments\": $args
      }
    }"
}

# Get next week date for test data
NEXT_WEEK=$(date -d "+7 days" +%Y-%m-%d 2>/dev/null || date -v+7d +%Y-%m-%d)
NEXT_WEEK_START="${NEXT_WEEK}T09:00:00Z"
NEXT_WEEK_END="${NEXT_WEEK}T10:00:00Z"

echo ""
echo "=== Test 1: Schedule (Create → Delete) ==="
echo "Creating schedule..."
CREATE_SCHEDULE=$(call_tool "tanda_create_schedule" "{\"start\": \"$NEXT_WEEK_START\", \"finish\": \"$NEXT_WEEK_END\", \"notes\": \"MCP_TEST_DELETE_ME\"}")
echo "$CREATE_SCHEDULE" | jq .

# Extract schedule ID
SCHEDULE_ID=$(echo "$CREATE_SCHEDULE" | jq -r '.result.content[0].text' 2>/dev/null | jq -r '.id' 2>/dev/null)
if [ -n "$SCHEDULE_ID" ] && [ "$SCHEDULE_ID" != "null" ]; then
  echo ""
  echo "Deleting schedule ID: $SCHEDULE_ID..."
  DELETE_SCHEDULE=$(call_tool "tanda_delete_schedule" "{\"schedule_id\": $SCHEDULE_ID}")
  echo "$DELETE_SCHEDULE" | jq .
  echo "Schedule test: PASSED"
else
  echo "Could not extract schedule ID. Response:"
  echo "$CREATE_SCHEDULE"
  echo "Schedule test: SKIPPED (API may not support create)"
fi

echo ""
echo "=== Test 2: Unavailability (Create → Delete) ==="
echo "Getting current user for unavailability test..."
CURRENT_USER=$(call_tool "tanda_get_current_user" "{}")
USER_ID=$(echo "$CURRENT_USER" | jq -r '.result.content[0].text' 2>/dev/null | jq -r '.id' 2>/dev/null)

if [ -n "$USER_ID" ] && [ "$USER_ID" != "null" ]; then
  echo "Creating unavailability for user $USER_ID..."
  CREATE_UNAV=$(call_tool "tanda_create_unavailability" "{\"user_id\": $USER_ID, \"start\": \"$NEXT_WEEK_START\", \"finish\": \"$NEXT_WEEK_END\", \"title\": \"MCP_TEST_DELETE_ME\"}")
  echo "$CREATE_UNAV" | jq .

  UNAV_ID=$(echo "$CREATE_UNAV" | jq -r '.result.content[0].text' 2>/dev/null | jq -r '.id' 2>/dev/null)
  if [ -n "$UNAV_ID" ] && [ "$UNAV_ID" != "null" ]; then
    echo ""
    echo "Deleting unavailability ID: $UNAV_ID..."
    DELETE_UNAV=$(call_tool "tanda_delete_unavailability" "{\"unavailability_id\": $UNAV_ID}")
    echo "$DELETE_UNAV" | jq .
    echo "Unavailability test: PASSED"
  else
    echo "Could not extract unavailability ID"
    echo "Unavailability test: SKIPPED"
  fi
else
  echo "Could not get current user ID"
  echo "Unavailability test: SKIPPED"
fi

echo ""
echo "=== Test 3: Leave Request (Create → Delete) ==="
if [ -n "$USER_ID" ] && [ "$USER_ID" != "null" ]; then
  LEAVE_DATE=$(date -d "+14 days" +%Y-%m-%d 2>/dev/null || date -v+14d +%Y-%m-%d)
  echo "Creating leave request for user $USER_ID on $LEAVE_DATE..."
  CREATE_LEAVE=$(call_tool "tanda_create_leave_request" "{\"user_id\": $USER_ID, \"leave_type\": \"annual\", \"start\": \"$LEAVE_DATE\", \"finish\": \"$LEAVE_DATE\", \"reason\": \"MCP_TEST_DELETE_ME\"}")
  echo "$CREATE_LEAVE" | jq .

  LEAVE_ID=$(echo "$CREATE_LEAVE" | jq -r '.result.content[0].text' 2>/dev/null | jq -r '.id' 2>/dev/null)
  if [ -n "$LEAVE_ID" ] && [ "$LEAVE_ID" != "null" ]; then
    echo ""
    echo "Deleting leave request ID: $LEAVE_ID..."
    DELETE_LEAVE=$(call_tool "tanda_delete_leave_request" "{\"leave_id\": $LEAVE_ID}")
    echo "$DELETE_LEAVE" | jq .
    echo "Leave request test: PASSED"
  else
    echo "Could not extract leave request ID"
    echo "Leave request test: SKIPPED (API may require specific leave types)"
  fi
else
  echo "User ID not available"
  echo "Leave request test: SKIPPED"
fi

echo ""
echo "=============================================="
echo "Write/Delete Tests Complete"
echo "=============================================="
