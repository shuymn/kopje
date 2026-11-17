# frozen_string_literal: true

# Every activity a Mastodon release LD-signs, as its own serializers write it and its own LinkedDataSignature#sign!
# signs it, for corpus.json (inbox-signed-forms.test.ts). Run inside a Mastodon web container, one local account named:
#
#   docker compose exec -T web bin/rails runner "$(cat capture.rb)" <username> > payloads.json
#
# Nothing is written: every record is built in memory inside a transaction that is rolled back. The output is a JSON
# array of { name, sender, received }, with the server's host replaced by mastodon.example, the remote host by
# kopje.test and the signature value by a placeholder; compact.rb then adds Mastodon's reading of each received body.

include Payloadable

username = ARGV.fetch(0)
REMOTE = 'kopje.test'
SENDER = "mastodon-#{Mastodon::Version}"
PLACEHOLDER = 'placeholder-signature-value'
out = []

local = Rails.configuration.x.local_domain

ActiveRecord::Base.transaction do
  account = Account.find_local!(username)
  t = Time.utc(2026, 11, 16, 12, 0, 0)
  remote = Account.new(id: Mastodon::Snowflake.id_at(t - 3600), username: 'alice', domain: REMOTE,
                       uri: "https://#{REMOTE}/ap/users/alice", url: "https://#{REMOTE}/@alice",
                       inbox_url: "https://#{REMOTE}/ap/users/alice/inbox", protocol: :activitypub)
  remote_status = Status.new(id: Mastodon::Snowflake.id_at(t - 1800), account: remote,
                             uri: "https://#{REMOTE}/ap/o/remote-1", url: "https://#{REMOTE}/@alice/remote-1",
                             text: 'remote', visibility: :public, created_at: t - 1800, updated_at: t - 1800)
  seq = 0
  sign = ->(json) { ActivityPub::LinkedDataSignature.new(json).sign!(account) }
  add = lambda do |name, record, serializer, **options|
    out << { name: name, sender: SENDER, received: sign.call(serialize_payload(record, serializer, options)) }
  end
  status = lambda do |**attrs|
    seq += 1
    Status.new(id: Mastodon::Snowflake.id_at(t + seq), account: account, visibility: :public, language: 'en',
               created_at: t + seq, updated_at: t + seq, local: true, **attrs)
  end

  # Update(Person): a display name with a custom emoji, a bio with a hashtag and a link, four fields, attribution
  # domains and a featured hashtag.
  emoji = CustomEmoji.new(id: 1, shortcode: 'kopje', domain: nil, image_file_name: 'kopje.png',
                          image_content_type: 'image/png', image_updated_at: t, updated_at: t)
  tag = Tag.new(id: 1, name: 'kopje', display_name: 'Kopje')
  account.display_name = 'Alice :kopje:'
  account.note = 'Bio with #kopje and https://example.com/page'
  account.fields = [{ name: 'Site', value: 'https://example.com' }, { name: 'Pronouns', value: 'they/them' },
                    { name: 'Matrix', value: '@alice:example.com' },
                    { name: 'Since', value: '2026' }].map(&:stringify_keys)
  account.attribution_domains = ['example.com', 'news.example']
  account.define_singleton_method(:emojis) { [emoji] }
  account.define_singleton_method(:tags) { [tag] }
  add.call('Update(Person)', account, ActivityPub::UpdateActorSerializer)

  # Create and Update of a Note.
  add.call('Create(Note) plain', status.call(text: 'A plain post'), ActivityPub::CreateNoteSerializer)
  mention = Mention.new(account: remote, silent: false)
  rich = status.call(text: "Hello @alice@#{REMOTE} :kopje: #kopje #ActivityPub", spoiler_text: 'Content warning',
                     sensitive: true)
  rich.define_singleton_method(:active_mentions) { [mention] }
  rich.define_singleton_method(:tags) { [tag, Tag.new(id: 2, name: 'activitypub', display_name: 'ActivityPub')] }
  rich.define_singleton_method(:emojis) { [emoji] }
  media = [1, 2].map do |n|
    MediaAttachment.new(id: Mastodon::Snowflake.id_at(t + n), account: account, type: :image, description: "Image #{n}",
                        blurhash: 'UBL_:rOpGG-;~qRjWBay00xu-;of4.WBt7of', file_file_name: "image#{n}.png",
                        file_content_type: 'image/png', file_file_size: 1024, file_updated_at: t,
                        file_meta: { 'original' => { 'width' => 640, 'height' => 480 },
                                     'focus' => { 'x' => 0.5, 'y' => -0.25 } })
  end
  rich.define_singleton_method(:ordered_media_attachments) { media }
  add.call('Create(Note) rich', rich, ActivityPub::CreateNoteSerializer)
  rich.edited_at = t + 60
  rich.text = "#{rich.text} (edited)"
  add.call('Update(Note)', rich, ActivityPub::UpdateNoteSerializer)
  add.call('Delete(Note)', status.call(text: 'Deleted'), ActivityPub::DeleteNoteSerializer)

  # Announce of a remote status, and its Undo.
  boost = status.call(reblog: remote_status, text: '')
  add.call('Announce', boost, ActivityPub::AnnounceNoteSerializer)
  add.call('Undo(Announce)', boost, ActivityPub::UndoAnnounceSerializer)

  # Create and Update of a Question.
  question = status.call(text: 'A poll')
  poll = Poll.new(id: 1, account: account, status: question, options: %w(Yes No), cached_tallies: [2, 1],
                  votes_count: 3, voters_count: 3, multiple: false, expires_at: t + 86_400)
  question.define_singleton_method(:preloadable_poll) { poll }
  question.define_singleton_method(:poll) { poll }
  add.call('Create(Question)', question, ActivityPub::CreateNoteSerializer)
  add.call('Update(Question)', question, ActivityPub::UpdatePollSerializer)

  # Delete of the account.
  add.call('Delete(Person)', account, ActivityPub::DeleteActorSerializer)

  # Add and Remove of a featured hashtag.
  featured = FeaturedTag.new(id: 1, account: account, tag: tag, name: 'kopje')
  add.call('Add(Hashtag)', featured, ActivityPub::AddHashtagSerializer)
  add.call('Remove(Hashtag)', featured, ActivityPub::RemoveHashtagSerializer)

  # Move to the remote account.
  add.call('Move', AccountMigration.new(id: 1, account: account, target_account: remote, acct: "alice@#{REMOTE}"),
           ActivityPub::MoveSerializer)

  # A QuoteRequest for the remote status, its quoting status inlined.
  quoting = status.call(text: 'Quoting')
  quote = Quote.new(id: Mastodon::Snowflake.id_at(t + 100), account: account, status: quoting,
                    quoted_status: remote_status, quoted_account: remote,
                    activity_uri: "https://#{local}/users/#{username}/quote_requests/1")
  quoting.define_singleton_method(:quote) { quote }
  add.call('QuoteRequest', quote, ActivityPub::QuoteRequestSerializer, allow_post_inlining: true)

  # The Delete of the stamp of a remote status quoting a local one.
  quoted = status.call(text: 'Quoted')
  stamp = Quote.new(id: Mastodon::Snowflake.id_at(t + 200), account: remote, status: remote_status,
                    quoted_status: quoted, quoted_account: account, state: :accepted)
  add.call('Delete(QuoteAuthorization)', stamp, ActivityPub::DeleteQuoteAuthorizationSerializer,
           force_approval_id: true)

  # A FeatureRequest for the remote account in a local collection, and the Delete of the stamp of a remote collection
  # featuring the local account.
  collection = Collection.new(id: Mastodon::Snowflake.id_at(t + 300), account: account, name: 'Friends',
                              local: true, discoverable: true, sensitive: false)
  item = CollectionItem.new(id: Mastodon::Snowflake.id_at(t + 301), collection: collection, account: remote,
                            activity_uri: "https://#{local}/users/#{username}/feature_requests/1")
  add.call('FeatureRequest', item, ActivityPub::FeatureRequestSerializer)
  remote_collection = Collection.new(id: Mastodon::Snowflake.id_at(t + 400), account: remote, name: 'Featured',
                                     local: false, discoverable: true, sensitive: false,
                                     uri: "https://#{REMOTE}/ap/users/alice/collections/1")
  featured_item = CollectionItem.new(id: Mastodon::Snowflake.id_at(t + 401), collection: remote_collection,
                                     account: account, uri: "https://#{REMOTE}/ap/users/alice/collections/1/items/1")
  add.call('Delete(FeatureAuthorization)', featured_item, ActivityPub::DeleteFeatureAuthorizationSerializer)

  raise ActiveRecord::Rollback
end

json = JSON.generate(out).gsub(local, 'mastodon.example')
out = JSON.parse(json)
out.each { |entry| entry['received']['signature']['signatureValue'] = PLACEHOLDER }
puts JSON.pretty_generate(out)
