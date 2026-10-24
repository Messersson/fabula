# Fabula Docker 镜像
# 用法: docker build -t fabula .
FROM node:22-alpine

WORKDIR /app

# 只复制运行所需源码，绝不把 config.json、data/ 或书稿打进镜像
COPY server.js docker-entrypoint.sh /app/
COPY lib /app/lib
COPY web /app/web
RUN chmod +x /app/docker-entrypoint.sh

# 运行时目录与端口
ENV NODE_ENV=production \
    BIND=0.0.0.0 \
    PORT=17381

EXPOSE 17381

# 数据可持久化挂载: -v /path/to/data:/app/data
VOLUME ["/app/data"]

ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["node", "server.js"]
