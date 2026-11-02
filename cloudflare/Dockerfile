# ponytail: upstream image == this fork at 3.3.5; build ../Dockerfile instead once we carry app patches.
FROM docuseal/docuseal:3.3.5

COPY --from=litestream/litestream:0.5.17 /usr/local/bin/litestream /usr/local/bin/litestream
COPY litestream.yml /etc/litestream.yml

# Container disk is ephemeral: restore SQLite from R2 on boot, then stream every write back while Puma runs.
CMD ["sh", "-c", "litestream restore -if-db-not-exists -if-replica-exists /data/docuseal/db.sqlite3 && exec litestream replicate -exec '/app/bin/bundle exec puma -C /app/config/puma.rb --dir /app'"]
