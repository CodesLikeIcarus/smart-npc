# Requires ffmpeg, websocat, and jq
deepgram_api_endpoint="wss://api.deepgram.com/v2/listen?eot_threshold=0.7&eot_timeout_ms=5000&model=flux-general-en&encoding=linear16&sample_rate=16000"

ffmpeg -loglevel error \
  -i https://playerservices.streamtheworld.com/api/livestream-redirect/CSPANRADIOAAC.aac \
  -f s16le -ar 16000 -ac 1 - | \
  websocat -v -H "Authorization: Token 7df6bcd4fabb00cb9a7c315a5844a71c284b5969" \
    -b --base64-text "$deepgram_api_endpoint" | \
  {
    while read -r msg; do
      if [[ -n "$msg" ]]; then
        json=$(echo "$msg" | base64 -d)
        event=$(echo "$json" | jq -r '.event // empty')
        turn_index=$(echo "$json" | jq -r '.turn_index // empty')
        transcript=$(echo "$json" | jq -r '.transcript // empty')
        eot_confidence=$(echo "$json" | jq -r '.end_of_turn_confidence // empty')
        if [[ "$event" == "StartOfTurn" ]]; then
          echo "--- StartOfTurn (Turn $turn_index) ---"
        fi
        if [[ -n "$transcript" ]]; then
          echo "$transcript"
        fi
        if [[ "$event" == "EndOfTurn" ]]; then
          echo "--- EndOfTurn (Turn $turn_index, Confidence: $eot_confidence) ---"
        fi
      fi
    done
  }