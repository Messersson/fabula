# Fabula Docker 镜像
# 用法: docker build -t fabula .
FROM node:22-alpine

WORKDIR /app

# 只复制运行所需源码，绝不把 config.json、data/ 或书稿打进镜像。
# resources/ 是代码资产（种子库、默认提示词、书源、敏感词），必须随镜像走。
COPY server.js docker-entrypoint.sh /app/
COPY lib /app/lib
COPY web /app/web
COPY resources /app/resources
COPY scripts/seed-doc-skills.cjs /app/scripts/seed-doc-skills.cjs
RUN chmod +x /app/docker-entrypoint.sh

# 运行时目录与端口
ENV NODE_ENV=production \
    BIND=0.0.0.0 \
    PORT=17381 \
    FABULA_DB_PATH=/app/runtime/writerx.db

EXPOSE 17381

# 数据可持久化挂载: -v /path/to/data:/app/data
VOLUME ["/app/data", "/app/runtime"]

ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["node", "server.js"]
