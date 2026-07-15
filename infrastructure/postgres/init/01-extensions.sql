-- Family Memory AI — PostgreSQL 초기화 (docker-entrypoint-initdb.d, 최초 볼륨 생성 시 1회 실행)
-- 확장은 여기서 생성한다. 앱 마이그레이션(drizzle)은 확장 생성을 가정한다.
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
SET TIME ZONE 'Asia/Seoul';
