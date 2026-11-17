#import <AppKit/AppKit.h>
#include <node_api.h>
#include <cstring>

namespace {
struct Monitor {
  napi_env env;
  napi_ref callback;
  napi_async_context context;
  id token;
};

void RemoveMonitor(void* data) {
  auto* monitor = static_cast<Monitor*>(data);
  [NSEvent removeMonitor:monitor->token];
  napi_async_destroy(monitor->env, monitor->context);
  napi_delete_reference(monitor->env, monitor->callback);
  delete monitor;
}

napi_value StopWatching(napi_env env, napi_callback_info info) {
  void* monitor;
  if (napi_get_cb_info(env, info, nullptr, nullptr, nullptr, &monitor) == napi_ok &&
      napi_remove_env_cleanup_hook(env, RemoveMonitor, monitor) == napi_ok) {
    RemoveMonitor(monitor);
  }
  return nullptr;
}

napi_value WatchForceClick(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2];
  void* handle = nullptr;
  size_t size = 0;
  napi_valuetype type;
  if (napi_get_cb_info(env, info, &argc, args, nullptr, nullptr) != napi_ok ||
      argc != 2 || napi_get_buffer_info(env, args[0], &handle, &size) != napi_ok ||
      size != sizeof(NSView*) || napi_typeof(env, args[1], &type) != napi_ok ||
      type != napi_function) {
    napi_throw_type_error(env, nullptr, "Expected a native window handle and callback");
    return nullptr;
  }
  void* viewPointer;
  std::memcpy(&viewPointer, handle, size);
  __weak NSView* view = (__bridge NSView*)viewPointer;
  auto* monitor = new Monitor{env};
  napi_create_reference(env, args[1], 1, &monitor->callback);
  napi_value name;
  napi_create_string_utf8(env, "ForceClick", NAPI_AUTO_LENGTH, &name);
  napi_async_init(env, nullptr, name, &monitor->context);
  __block bool fired = false;
  monitor->token = [NSEvent addLocalMonitorForEventsMatchingMask:
      NSEventMaskPressure | NSEventMaskLeftMouseUp | NSEventMaskLeftMouseDown
      handler:^NSEvent*(NSEvent* event) {
    if (event.type != NSEventTypePressure) {
      fired = false;
      return event;
    }
    NSView* content = view;
    if (fired || event.stage != 2 || !content ||
        event.window != content.window || !content.window.isKeyWindow) return event;
    fired = true;
    NSPoint point = [content convertPoint:event.locationInWindow fromView:nil];
    NSRect bounds = content.bounds;
    if (!NSPointInRect(point, bounds)) return event;

    napi_handle_scope scope;
    if (napi_open_handle_scope(env, &scope) != napi_ok) return event;
    napi_value callback, receiver, coords[2];
    napi_get_reference_value(env, monitor->callback, &callback);
    napi_get_global(env, &receiver);
    napi_create_double(env, point.x - NSMinX(bounds), &coords[0]);
    double y = content.isFlipped ? point.y - NSMinY(bounds) : NSMaxY(bounds) - point.y;
    napi_create_double(env, y, &coords[1]);
    napi_make_callback(env, monitor->context, receiver, callback, 2, coords, nullptr);
    napi_close_handle_scope(env, scope);
    return event;
  }];
  napi_add_env_cleanup_hook(env, RemoveMonitor, monitor);
  napi_value stop;
  napi_create_function(env, nullptr, 0, StopWatching, monitor, &stop);
  return stop;
}
}  // namespace

NAPI_MODULE_INIT() {
  napi_value watch;
  napi_create_function(env, "watch", NAPI_AUTO_LENGTH, WatchForceClick, nullptr, &watch);
  napi_set_named_property(env, exports, "watch", watch);
  return exports;
}
