# frozen_string_literal: true

# Minimal Mixin echo bot over Blaze (mixin_bot gem).
#
# Reads a keystore JSON file (path from --keystore or ENV['KEYSTORE']),
# echoes every inbound PLAIN_TEXT back to the sender as "echo: <text>"
# with a reply message_id derived deterministically from the inbound
# message_id, so redeliveries never produce duplicate replies.
#
# Messaging-only keystores work: app_id + session_id + session_private_key
# are enough; the spend key is never needed here.
#
# Usage: ruby echo.rb [--keystore path]   (or set KEYSTORE)

require 'digest'
require 'eventmachine'
require 'faye/websocket'
require 'json'
require 'mixin_bot'

$stdout.sync = true # flush logs immediately under systemd/docker/pipes

USAGE = <<~USAGE
  usage: ruby echo.rb [--keystore path]   (or set KEYSTORE)

  The keystore is a JSON file with at least:
    {"app_id": "...", "session_id": "...", "session_private_key": "..."}
  Spend key / server public key are not required for messaging.
USAGE

def load_keystore
  index = ARGV.index('--keystore')
  path = index ? ARGV[index + 1] : ENV['KEYSTORE']
  abort USAGE unless path # abort = exit 1, no network

  ks = JSON.parse(File.read(path))
  # NOTE: never log ks — it holds secrets.
  ks['app_id'] ||= ks['client_id']
  missing = %w[app_id session_id session_private_key].reject { |k| ks[k].to_s != '' }
  abort "keystore is missing #{missing.join(', ')}" unless missing.empty?
  ks
end

# Same inbound id -> same reply id -> the network dedupes re-sent replies.
def deterministic_reply_id(inbound_id)
  h = Digest::SHA256.hexdigest("echo:#{inbound_id}")[0, 32]
  "#{h[0, 8]}-#{h[8, 4]}-#{h[12, 4]}-#{h[16, 4]}-#{h[20, 12]}"
end

KEYSTORE = load_keystore
# mixin_bot 3.x runs this block with instance_exec: use self.x =, not a |config| param (that is nil).
MixinBot.configure do
  self.app_id = KEYSTORE['app_id']
  self.session_id = KEYSTORE['session_id']
  self.session_private_key = KEYSTORE['session_private_key']
end

API = MixinBot.api
CONNECTED_AT = {}
BACKOFF = { seconds: 1 }
RECONNECT_ARMED = { armed: false }

def schedule_reconnect
  return if RECONNECT_ARMED[:armed]

  RECONNECT_ARMED[:armed] = true
  wait = BACKOFF[:seconds] / 2.0 + rand * BACKOFF[:seconds]
  puts "[#{Time.now}] reconnecting in #{wait.round(2)}s"
  EM.add_timer(wait) do
    RECONNECT_ARMED[:armed] = false
    connect
    BACKOFF[:seconds] *= 2
    BACKOFF[:seconds] = 60 if BACKOFF[:seconds] > 60
  end
end

def connect
  started = Time.now
  # reconnect: false — we own reconnection so we can apply backoff.
  API.start_blaze_connect(reconnect: false) do
    def on_open(blaze, _event)
      # Ask for messages that arrived while we were offline; anything we
      # already answered is deduped by the deterministic reply message_id.
      blaze.send API.list_pending_message
      puts "[#{Time.now}] blaze open"
    end

    def on_message(blaze, event)
      raw = JSON.parse(API.ws_message(event.data))
      data = raw['data'].is_a?(Hash) ? raw['data'] : {}
      return unless (message_id = data['message_id'])

      # Ack FIRST (after parsing) so the gateway stops redelivering; the
      # idempotent reply makes the remaining crash window safe.
      blaze.send API.acknowledge_message_receipt(message_id)

      return unless data['category'] == 'PLAIN_TEXT'
      return if data['user_id'] == MixinBot.config.app_id # own messages

      text = data['data_base64'].to_s.tr('-_', '+/').unpack1('m').force_encoding('UTF-8') # core base64 (the base64 gem left Ruby's defaults in 3.4); accepts URL-safe input too
      puts "[#{Time.now}] echo -> conversation #{data['conversation_id']} user #{data['user_id']}"
      # Sending over REST, not the socket (recommended for workers).
      API.send_text_message(
        conversation_id: data['conversation_id'],
        recipient_id: data['user_id'],
        message_id: deterministic_reply_id(message_id),
        data: "echo: #{text}"
      )
    rescue MixinBot::APIError => e
      warn "[#{Time.now}] api error #{e.code}: #{e.description} (#{e.request_id})"
    rescue StandardError => e
      warn "[#{Time.now}] handler error: #{e}"
    end

    def on_error(_blaze, event)
      warn "[#{Time.now}] blaze error: #{event.message}"
    end

    def on_close(_blaze, event)
      puts "[#{Time.now}] blaze closed (#{event.code} #{event.reason})"
      schedule_reconnect
    end
  end
  CONNECTED_AT[:t] = started
end

EM.run do
  connect
  # Healthy 60s runs reset the backoff ladder.
  EM.add_periodic_timer(30) do
    BACKOFF[:seconds] = 1 if CONNECTED_AT[:t] && Time.now - CONNECTED_AT[:t] > 60
  end
end
