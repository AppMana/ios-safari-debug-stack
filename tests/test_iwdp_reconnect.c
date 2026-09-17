/* Exercise real proxy lifecycle with simulated socket/USB callbacks. */
#include <assert.h>
#include <stdbool.h>
#include <sys/types.h>
#include <string.h>
#include <stdio.h>
#include "ios_webkit_debug_proxy.h"

static void *values[10000];
static bool servers[10000];
static int phone_attempts, ipad_attempts;
static int subscribe_device(iwdp_t self) { return 100; }
static int listen_port(iwdp_t self, int port) { return port; }
static iwdp_status select_port(iwdp_t self, const char *id, int *port, int *min, int *max) {
  if (id && !strcmp(id, "SIMULATOR")) return IWDP_ERROR;
  *port = !id ? 9221 : !strcmp(id, "phone") ? 9222 : 9223;
  return IWDP_SUCCESS;
}
static int attach_device(iwdp_t self, const char *id, char **out_id, char **name, int *os, void **ssl) {
  if (!strcmp(id, "phone")) {
    phone_attempts++;
    if (phone_attempts == 1) return -1; /* SSL failure while reconnecting */
    return 200;
  }
  ipad_attempts++;
  return 201;
}
static iwdp_status add_fd(iwdp_t self, int fd, void *ssl, void *value, bool server) {
  values[fd] = value;
  servers[fd] = server;
  return IWDP_SUCCESS;
}
static iwdp_status remove_fd(iwdp_t self, int fd) {
  void *value = values[fd];
  values[fd] = NULL;
  return value ? self->on_close(self, fd, value, servers[fd]) : IWDP_SUCCESS;
}
static iwdp_status send_data(iwdp_t self, int fd, const char *data, size_t length) { return IWDP_SUCCESS; }
int main(void) {
  iwdp_t proxy = iwdp_new(NULL, "localhost:27753");
  proxy->subscribe = subscribe_device;
  proxy->listen = listen_port;
  proxy->select_port = select_port;
  proxy->attach = attach_device;
  proxy->add_fd = add_fd;
  proxy->remove_fd = remove_fd;
  proxy->send = send_data;
  assert(proxy->start(proxy) == IWDP_SUCCESS);
  iwdp_retry_attach(proxy, "phone");
  assert(phone_attempts == 1 && values[200] == NULL);
  iwdp_retry_attach(proxy, "ipad");
  assert(ipad_attempts == 1 && values[201] != NULL);
  void *ipad_connection = values[201];
  iwdp_retry_attach(proxy, "phone");
  assert(phone_attempts == 2 && values[200] != NULL);
  iwdp_retry_attach(proxy, "phone");
  iwdp_retry_attach(proxy, "ipad");
  assert(phone_attempts == 2 && ipad_attempts == 1);
  assert(values[201] == ipad_connection);
  /* A failed established transport is also recovered without restarting iPad. */
  remove_fd(proxy, 200);
  iwdp_retry_attach(proxy, "phone");
  assert(phone_attempts == 3 && values[200] != NULL);
  assert(values[201] == ipad_connection && ipad_attempts == 1);
  puts("PASS: failed attach and lost transport recover; other device survives");
  return 0;
}
