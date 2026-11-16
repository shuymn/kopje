# frozen_string_literal: true

# What Mastodon applies from each entry, with its readers: ActivityPub::ProcessActivityService#call (compaction,
# patch_for_forwarding!, ActivityPub::Activity.factory and #perform) run in the reference release's web container on
# the body as received, from a remote `bob` (the entries' actor) to a local account named on the command line:
#
#   docker compose exec -T web bin/rails runner "$(cat effects.rb)" <username> < forms.json > effects.json
#
# Nothing is kept: each entry runs in its own transaction, rolled back, with Sidekiq's jobs held in memory and dropped
# (what they would do later, notifications and fetches, is not observed). The entries' local references (kopje.test)
# are rewritten to records made inside that transaction: the local account, its statuses local-1 and local-2, and its
# follow request to bob (follows/1; for an entry named for an accepted follow, its follow of bob); bob's own statuses
# (deleted, pinned, quoting), bob2 and, for an Undo, his follow of the local account (follows/14) are made there too.
# The output lists, per entry, what bob's activity left: statuses (text, spoiler, sensitive, reply, poll, mentions,
# visibility), his display name, follows and follow requests, favourites, blocks, reblogs, pins, reports, quotes,
# removed statuses, follows and follow requests (his, and the local account's of him), and any error the job would
# raise (Sidekiq then retries it). effects.json is this over forms.json's entries, run on Mastodon 4.7.5 as alice.

require 'sidekiq/testing'
Sidekiq::Testing.fake!

username = ARGV.fetch(0)
LOCAL = 'https://kopje.test'
BOB = 'https://mastodon.example/users/bob'

def remote_account(name, **attrs)
  uri = "https://mastodon.example/users/#{name}"
  Account.new(username: name, domain: 'mastodon.example', uri: uri, url: "https://mastodon.example/@#{name}",
              inbox_url: "#{uri}/inbox", followers_url: "#{uri}/followers",
              featured_collection_url: "#{uri}/collections/featured", protocol: :activitypub,
              public_key: OpenSSL::PKey::RSA.new(2048).public_key.to_pem, **attrs).tap { |a| a.save!(validate: false) }
end

def remote_status(account, name, **attrs)
  Status.create!(account: account, uri: "#{account.uri}/statuses/#{name}", url: "#{account.uri}/statuses/#{name}",
                 text: name, visibility: :public, local: false, **attrs)
end

def uri(status)
  ActivityPub::TagManager.instance.uri_for(status)
end

def effect(bob, before) # rubocop:disable Metrics/AbcSize
  statuses = Status.where(account: bob).where.not(id: before[:statuses].keys).map do |s|
    {
      uri: s.uri, text: s.text, spoiler: s.spoiler_text, sensitive: s.sensitive, visibility: s.visibility,
      reply_to: s.thread && uri(s.thread), reblog_of: s.reblog && uri(s.reblog), poll: s.preloadable_poll&.options,
      mentions: s.mentions.map { |m| m.account.acct }, media: s.media_attachments.size,
      quote: s.quote && { uri: s.quote.quoted_status && uri(s.quote.quoted_status), state: s.quote.state }
    }.compact
  end
  {
    statuses: statuses,
    removed_statuses: before[:statuses].filter_map do |id, uri|
      status = Status.with_discarded.find_by(id: id)
      uri if status.nil? || status.deleted_at.present?
    end,
    follows: Follow.where(account: bob).where.not(id: before[:follows]).map { |f| f.target_account.acct },
    removed_follows: (before[:follows] - Follow.where(id: before[:follows]).pluck(:id)).size,
    follow_requests: FollowRequest.where(account: bob).map { |f| f.target_account.acct },
    local_requests_removed: (before[:requests] - FollowRequest.where(id: before[:requests]).pluck(:id)).size,
    local_follows: Follow.where(target_account: bob).map { |f| f.account.acct },
    local_follows_removed: (before[:local_follows] - Follow.where(id: before[:local_follows]).pluck(:id)).size,
    favourites: Favourite.where(account: bob).map { |f| uri(f.status) },
    blocks: Block.where(account: bob).map { |b| b.target_account.acct },
    pins: StatusPin.where(account: bob).map { |p| uri(p.status) },
    reports: Report.where(account: bob).map { |r| { target: r.target_account.acct, statuses: r.status_ids.size } },
    quotes: Quote.where(account: bob).where.not(id: before[:quotes]).map do |q|
      { status: q.status && uri(q.status), state: q.state }
    end,
    moved_to: bob.reload.moved_to_account&.acct,
    display_name: bob.display_name.presence,
  }.reject { |_, v| v.nil? || v == [] || v == 0 }
end

entries = JSON.parse($stdin.read)
results = entries.map do |entry|
  result = { name: entry['name'], sender: entry['sender'] }.compact
  ActiveRecord::Base.transaction do
    local = Account.find_local!(username)
    bob = remote_account('bob')
    remote_account('bob2', also_known_as: [bob.uri])
    local1 = Status.create!(account: local, text: 'local 1', visibility: :public)
    local2 = Status.create!(account: local, text: 'local 2', visibility: :public)
    ours = entry['name'].include?('accepted follow') ? Follow : FollowRequest
    request = ours.create!(account: local, target_account: bob,
                           uri: "https://#{Rails.configuration.x.local_domain}/follows/1")
    remote_status(bob, 'deleted')
    pinned = remote_status(bob, 'pinned')
    quoting = remote_status(bob, 'quoting')
    Quote.create!(account: bob, status: quoting, quoted_status: local1, quoted_account: local, state: :pending)
    undo = entry['name'].start_with?('Undo')
    Follow.create!(account: bob, target_account: local, uri: "#{bob.uri}/follows/14") if undo
    StatusPin.create!(account: bob, status: pinned) if entry['name'].start_with?('Remove')
    tag = ActivityPub::TagManager.instance
    body = JSON.generate(entry['received'])
               .gsub("#{LOCAL}/ap/users/alice", tag.uri_for(local))
               .gsub("#{LOCAL}/ap/o/local-1", tag.uri_for(local1))
               .gsub("#{LOCAL}/ap/o/local-2", tag.uri_for(local2))
               .gsub("#{LOCAL}/ap/follows/1", request.uri)
    before = {
      statuses: Status.where(account: bob).pluck(:id, :uri).to_h,
      local_follows: Follow.where(target_account: bob).pluck(:id),
      follows: Follow.where(account: bob).pluck(:id),
      quotes: Quote.where(account: bob).pluck(:id),
      requests: FollowRequest.where(target_account: bob).pluck(:id),
    }
    begin
      ActivityPub::ProcessActivityService.new.call(body, bob)
    rescue StandardError => e
      result[:error] = "#{e.class}: #{e.message[0, 120]}"
    end
    # The local records' URIs are written back as the entries name them.
    result[:effect] = JSON.parse(JSON.generate(effect(bob, before))
                                     .gsub(tag.uri_for(local1), "#{LOCAL}/ap/o/local-1")
                                     .gsub(tag.uri_for(local2), "#{LOCAL}/ap/o/local-2"))
    Sidekiq::Worker.clear_all
    raise ActiveRecord::Rollback
  end
  result
end
puts JSON.pretty_generate(results)
