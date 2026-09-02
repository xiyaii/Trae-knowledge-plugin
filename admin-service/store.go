package main

import (
	"context"
	"fmt"
	"log"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Store 封装 PostgreSQL 数据操作
type Store struct {
	pool *pgxpool.Pool
}

// TrackEvent 埋点事件（对应插件端上报的 payload）
type TrackEvent struct {
	Event          string  `json:"event"`                     // install | login_success | query | feedback
	UserID         string  `json:"user_id,omitempty"`         // iCubeAuthInfo://usertag 的值
	MachineID      string  `json:"machine_id,omitempty"`      // vscode.env.machineId
	MsgID          string  `json:"msg_id,omitempty"`          // query / feedback 事件
	Query          string  `json:"query,omitempty"`           // query / feedback 事件
	Score          float64 `json:"score,omitempty"`           // 仅 query 事件
	DocName        string  `json:"doc_name,omitempty"`        // query / feedback 事件
	ChunkId        int     `json:"chunk_id,omitempty"`        // 知识库切片ID（query / feedback 事件）
	Answer         string  `json:"answer,omitempty"`          // AI 回答内容（feedback 事件）
	Platform       string  `json:"platform,omitempty"`        // darwin-arm64 / win32-x64
	PluginVer      string  `json:"plugin_ver,omitempty"`      // 插件版本
	Feedback       string  `json:"feedback,omitempty"`        // like | dislike（feedback 事件）
	FeedbackReason string  `json:"feedback_reason,omitempty"` // 点踩原因（多选以分号拼接）
	TS             int64   `json:"ts"`                        // 毫秒时间戳
}

// NewStore 创建 PostgreSQL 连接池
func NewStore(dsn string) (*Store, error) {
	pool, err := pgxpool.New(context.Background(), dsn)
	if err != nil {
		return nil, fmt.Errorf("创建连接池失败: %w", err)
	}
	return &Store{pool: pool}, nil
}

func (s *Store) Close() {
	s.pool.Close()
}

// InitDB 初始化表结构（幂等）
func (s *Store) InitDB() error {
	schema := `
	CREATE TABLE IF NOT EXISTS events (
		id          BIGSERIAL PRIMARY KEY,
		event_type  TEXT NOT NULL,
		user_id     TEXT,
		machine_id  TEXT,
		msg_id      TEXT,
		query_text  TEXT,
		score       REAL,
		doc_name    TEXT,
		platform    TEXT,
		plugin_ver  TEXT,
		ts          BIGINT NOT NULL,
		created_at  BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
	);
	CREATE INDEX IF NOT EXISTS idx_events_type_ts ON events(event_type, ts);
	CREATE INDEX IF NOT EXISTS idx_events_user    ON events(user_id);
	CREATE INDEX IF NOT EXISTS idx_events_machine  ON events(machine_id);

	CREATE TABLE IF NOT EXISTS daily_stats (
		stat_date  DATE NOT NULL,
		metric     TEXT NOT NULL,
		value      BIGINT NOT NULL,
		PRIMARY KEY (stat_date, metric)
	);

	-- 点踩反馈审核记录：审核确认后的 msg_id 不再看板展示，原始数据仍在 events 表保留
	CREATE TABLE IF NOT EXISTS feedback_reviews (
		msg_id      TEXT PRIMARY KEY,
		reviewed_at BIGINT NOT NULL
	);

	-- feedback 能力扩展（兼容已有数据，幂等）
	ALTER TABLE events ADD COLUMN IF NOT EXISTS feedback TEXT;
	ALTER TABLE events ADD COLUMN IF NOT EXISTS feedback_reason TEXT;
	ALTER TABLE events ADD COLUMN IF NOT EXISTS chunk_id INTEGER;
	ALTER TABLE events ADD COLUMN IF NOT EXISTS answer TEXT;

	-- P0-3: feedback 去重查询的核心索引
	-- dashboard 按 msg_id 分区取最新一条反馈，无索引时全表扫描
	CREATE INDEX IF NOT EXISTS idx_events_feedback_msg ON events(msg_id) WHERE event_type = 'feedback';
	CREATE INDEX IF NOT EXISTS idx_events_feedback_type ON events(event_type, feedback) WHERE feedback IS NOT NULL;
	`
	_, err := s.pool.Exec(context.Background(), schema)
	return err
}

// InsertEvent 写入一条埋点事件
func (s *Store) InsertEvent(e TrackEvent) error {
	_, err := s.pool.Exec(context.Background(),
		`INSERT INTO events (event_type, user_id, machine_id, msg_id, query_text, score, doc_name, chunk_id, answer, platform, plugin_ver, ts, feedback, feedback_reason)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
		e.Event, e.UserID, e.MachineID, e.MsgID, e.Query, e.Score, e.DocName, e.ChunkId, e.Answer, e.Platform, e.PluginVer, e.TS, e.Feedback, e.FeedbackReason,
	)
	return err
}

// ReviewFeedback 标记点踩反馈为已审核（按 msg_id，幂等）
// 审核后 HandleFeedback 查询将过滤该条，原始埋点数据仍保留在 events 表
func (s *Store) ReviewFeedback(msgID string) error {
	_, err := s.pool.Exec(context.Background(),
		`INSERT INTO feedback_reviews (msg_id, reviewed_at) VALUES ($1, $2)
		 ON CONFLICT (msg_id) DO NOTHING`,
		msgID, time.Now().UnixMilli(),
	)
	return err
}

// StartDailyAggregation 每日凌晨 00:05 刷新昨日的聚合数据
func (s *Store) StartDailyAggregation() {
	for {
		// 计算到下一个 00:05 的间隔
		now := time.Now()
		next := time.Date(now.Year(), now.Month(), now.Day()+1, 0, 5, 0, 0, now.Location())
		timer := time.NewTimer(next.Sub(now))
		<-timer.C
		s.refreshDailyStats()
	}
}

// refreshDailyStats 刷新昨日和今日的聚合统计
func (s *Store) refreshDailyStats() {
	dates := []time.Time{
		time.Now().AddDate(0, 0, -1), // 昨日
		time.Now(),                   // 今日
	}
	for _, d := range dates {
		dateStr := d.Format("2006-01-02")
		if err := s.aggregateForDate(dateStr); err != nil {
			log.Printf("聚合统计失败 date=%s: %v", dateStr, err)
		}
	}
}

// aggregateForDate 聚合指定日期的统计数据
func (s *Store) aggregateForDate(date string) error {
	// 当日 0 点和次日 0 点的毫秒时间戳
	t, _ := time.ParseInLocation("2006-01-02", date, time.Local)
	startTs := t.UnixMilli()
	endTs := t.AddDate(0, 0, 1).UnixMilli()

	metrics := map[string]string{
		"install_count": `SELECT COUNT(DISTINCT machine_id) FROM events WHERE event_type='install' AND ts >= $1 AND ts < $2`,
		"login_count":   `SELECT COUNT(DISTINCT user_id) FROM events WHERE event_type='login_success' AND ts >= $1 AND ts < $2`,
		"query_count":   `SELECT COUNT(*) FROM events WHERE event_type='query' AND ts >= $1 AND ts < $2`,
		"dau":           `SELECT COUNT(DISTINCT user_id) FROM events WHERE event_type='query' AND ts >= $1 AND ts < $2`,
	}

	for metric, sql := range metrics {
		var count int64
		err := s.pool.QueryRow(context.Background(), sql, startTs, endTs).Scan(&count)
		if err != nil {
			return err
		}
		_, err = s.pool.Exec(context.Background(),
			`INSERT INTO daily_stats (stat_date, metric, value) VALUES ($1, $2, $3)
			 ON CONFLICT (stat_date, metric) DO UPDATE SET value = EXCLUDED.value`,
			date, metric, count,
		)
		if err != nil {
			return err
		}
	}
	return nil
}
