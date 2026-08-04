import assert from 'node:assert/strict'
import test from 'node:test'
import { parseLanAnnouncement } from '../src/network/lan-discovery.js'

test('parses a Minecraft LAN multicast announcement', () => {
  assert.deepEqual(parseLanAnnouncement('[MOTD]Player - World[/MOTD][AD]53142[/AD]', '192.168.1.9'), {
    host: '192.168.1.9', port: 53142, motd: 'Player - World'
  })
})

test('rejects malformed or invalid LAN announcements', () => {
  assert.equal(parseLanAnnouncement('[MOTD]World[/MOTD][AD]99999[/AD]', '127.0.0.1'), null)
  assert.equal(parseLanAnnouncement('not minecraft', '127.0.0.1'), null)
})
