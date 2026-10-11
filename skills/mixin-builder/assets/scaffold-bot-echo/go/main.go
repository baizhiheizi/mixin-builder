// Command scaffold-bot-echo is a minimal Mixin echo bot over Blaze.
//
// It reads a keystore JSON file (path from --keystore or $KEYSTORE),
// connects to Blaze, and echoes every inbound PLAIN_TEXT message back to
// the sender as "echo: <text>" with a reply message_id derived
// deterministically from the inbound message_id, so redeliveries after a
// crash never produce duplicate replies.
//
// Messaging-only keystores work: only app_id, session_id and
// session_private_key are required. The spend key is never needed here.
package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"math/big"
	"os"
	"os/signal"
	"syscall"
	"time"

	bot "github.com/MixinNetwork/bot-api-go-client/v3"
)

const usage = `usage: echo-bot [--keystore path]   (or set $KEYSTORE)

The keystore is a JSON file with at least:
  {"app_id": "...", "session_id": "...", "session_private_key": "..."}
Spend key / server public key are not required for messaging.`

type keystore struct {
	AppID             string `json:"app_id"`
	ClientID          string `json:"client_id"` // dashboard legacy alias for app_id
	SessionID         string `json:"session_id"`
	SessionPrivateKey string `json:"session_private_key"`
}

// echoListener implements bot.BlazeListener. SyncAck() == true makes the
// SDK acknowledge every message with ACKNOWLEDGE_MESSAGE_RECEIPT (status
// READ) right after OnMessage returns — required to stop redelivery.
type echoListener struct {
	su *bot.SafeUser
}

func (l *echoListener) OnMessage(ctx context.Context, msg bot.MessageView, userID string) error {
	// Ignore non-text categories and anything we sent ourselves.
	if msg.Category != "PLAIN_TEXT" || msg.UserId == l.su.UserId {
		return nil
	}
	data, err := base64.RawURLEncoding.DecodeString(msg.DataBase64)
	if err != nil {
		log.Printf("decode message %s data: %v", msg.MessageId, err)
		return nil // ack it anyway; a bad payload will redeliver forever otherwise
	}
	replyID, err := deterministicReplyID(msg.MessageId)
	if err != nil {
		return err
	}
	log.Printf("echo -> conversation %s user %s (%d bytes)", msg.ConversationId, msg.UserId, len(data))
	return bot.PostMessage(ctx, msg.ConversationId, msg.UserId, replyID,
		"PLAIN_TEXT", base64.RawURLEncoding.EncodeToString([]byte("echo: "+string(data))), l.su)
}

func (l *echoListener) OnAckReceipt(ctx context.Context, msg bot.MessageView, userID string) error {
	return nil
}

func (l *echoListener) SyncAck() bool { return true }
// deterministicReplyID derives the reply message_id from the inbound one:
// same input → same UUID, so a re-sent reply is deduplicated by the network.
func deterministicReplyID(inbound string) (string, error) {
	sum := sha256.Sum256([]byte("echo:" + inbound))
	id, err := bot.UuidFromBytes(sum[:16])
	if err != nil {
		return "", err
	}
	return id.String(), nil
}

// jitterBackoff returns duration*(0.5..1.5) to avoid reconnect herds.
func jitterBackoff(d time.Duration) time.Duration {
	r, err := rand.Int(rand.Reader, big.NewInt(1000))
	if err != nil {
		return d
	}
	return d/2 + time.Duration(int64(d)*r.Int64()/1500)
}

func main() {
	keystorePath := flag.String("keystore", "", "path to keystore JSON (default $KEYSTORE)")
	flag.Parse()
	if *keystorePath == "" {
		*keystorePath = os.Getenv("KEYSTORE")
	}
	if *keystorePath == "" {
		fmt.Fprintln(os.Stderr, usage)
		os.Exit(1)
	}

	raw, err := os.ReadFile(*keystorePath)
	if err != nil {
		log.Fatalf("read keystore: %v", err)
	}
	var ks keystore
	if err := json.Unmarshal(raw, &ks); err != nil {
		log.Fatalf("parse keystore: %v", err)
	}
	if ks.AppID == "" {
		ks.AppID = ks.ClientID
	}
	if ks.AppID == "" || ks.SessionID == "" || ks.SessionPrivateKey == "" {
		log.Fatal("keystore is missing app_id/session_id/session_private_key")
	}
	// NOTE: never log ks or raw — keystore contents are secrets.

	su := &bot.SafeUser{
		UserId:            ks.AppID,
		SessionId:         ks.SessionID,
		SessionPrivateKey: ks.SessionPrivateKey,
	}
	blaze := bot.NewBlazeClientWithSafeUser(su)
	listener := &echoListener{su: su}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	backoff := time.Second
	for {
		started := time.Now()
		err := blaze.Loop(ctx, listener) // returns on disconnect; caller re-loops
		if ctx.Err() != nil {
			log.Print("shutting down")
			return
		}
		if time.Since(started) > time.Minute {
			backoff = time.Second // healthy run: reset
		}
		log.Printf("blaze disconnected: %v; reconnecting in %s", err, backoff)
		select {
		case <-ctx.Done():
			return
		case <-time.After(jitterBackoff(backoff)):
		}
		if backoff *= 2; backoff > time.Minute {
			backoff = time.Minute
		}
	}
}
