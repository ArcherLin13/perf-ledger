#define TBL_SIZE 2048
__kernel void tone_lut2048_1920(const int width) {
  const int x = get_global_id(0);
  const int y = get_global_id(1);
  float table[TBL_SIZE];
  table[0] = 0.0f;
  float v = table[(x + y * width) % TBL_SIZE];
}
